/// <reference lib="webworker" />

/**
 * US-0303 - transcription off the main thread.
 *
 * The worker owns the whole heavy half of the pipeline: model load, inference,
 * and for the rhythm path onset detection and classification. The main thread
 * only ever sees typed messages.
 *
 * Three engines live behind one protocol:
 *
 *   melody-extraction  the dedicated YIN/contour/segmentation path for voice.
 *   basic-pitch        the multipitch path for Instrument Mode, dynamically
 *                      imported so TensorFlow.js stays out of the initial bundle.
 *   rhythm             onset detection/classification for beatbox input.
 *
 * The fallback is honest, not silent: the result carries `transcriberId`, the
 * UI shows which engine produced it, and a `model_unavailable` warning is
 * attached to the diagnostics.
 *
 * ## The voice path now asks a second engine one question
 *
 * `melody-extraction` owns the voice transcription and still does. What it
 * cannot do is hear an octave leap: YIN locks onto the subharmonic, and on the
 * corpus case built for exactly this it reads C4→C5→C4 as C4→C4→C4 with 32.6%
 * octave error and complete confidence. No amount of reasoning over its own
 * output recovers information it never had.
 *
 * So Basic Pitch is run a second time on voice material — not as a competing
 * transcription, which it would be bad at, but as a *register witness*. It is
 * measured at 0% octave error on that case and at 0.08 note F1 on a held tone,
 * and `@evidence` uses exactly the half it is good at. When it is unavailable,
 * disabled, slow or wrong, the path is the one that shipped before it: the
 * candidate keeps its own register and the disagreement is reported.
 */

import {
  AppError,
  type MonoAudio,
  type NoteEvent,
  type ProcessingDiagnostics,
  type TranscriptionInputMode,
  type TranscriptionResult,
} from '@contracts';
import {
  peakNormalize,
  resample,
} from '@/packages/audio-core/normalize';
import { RhythmTranscriber } from '@/packages/audio-core/transcribers';
import { extractHumanMelody } from '@/packages/melody-extraction';
import { buildMusicalPhraseModel } from '@/packages/musical-phrase';
import { detectOnsets } from '@/packages/audio-core/onsets';
import { noteTransformations } from '@/packages/note-history';
import { judgeAndRepair, judgeFeaturesFromFrames } from '@musical-judge';
import { arbitrateRegister, notableDecisions, type EvidenceSource } from '@evidence';
import { classifyInput, reconcileClassificationWithMaterial } from '@intent';
import { mapMonotonicProgress, type ProgressWindow } from './transcription-progress';

export interface TranscribeRequest {
  type: 'transcribe';
  id: string;
  mode: TranscriptionInputMode;
  /** Transferred, not copied. */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  modelUrl: string;
  /** `false` forces the local monophonic fallback in Instrument Mode. */
  allowModel: boolean;
  noteThreshold: number;
  onsetThreshold: number;
  minNoteLengthSec: number;
}

export interface CancelRequest {
  type: 'cancel';
  id: string;
}

export type WorkerRequest = TranscribeRequest | CancelRequest;

export type WorkerResponse =
  | { type: 'progress'; id: string; stage: string; progress: number }
  | { type: 'result'; id: string; result: TranscriptionResult }
  | { type: 'error'; id: string; code: string; recovery: string; detail?: string };

/** Basic Pitch's model runs at 22.05 kHz; anything else must be resampled. */
const MODEL_SAMPLE_RATE = 22050;

const cancelled = new Set<string>();
const latestProgress = new Map<string, number>();
const progressWindows = new Map<string, ProgressWindow>();

/**
 * The request currently being worked on.
 *
 * Needed so that an error which escapes the normal `try`/`catch` - thrown from
 * a microtask deep inside a library, where no caller is awaiting it - can still
 * be reported against the request it ruined instead of vanishing. An error that
 * vanishes here leaves the UI on "working out what you sang" forever, which is
 * exactly the failure this guards against.
 */
let inFlight: string | null = null;

/** Cached across takes so a second recording does not reload the model. */
let cachedModel: { url: string; instance: unknown } | null = null;

const post = (message: WorkerResponse): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
};

function reportProgress(id: string, stage: string, progress: number): void {
  const window = progressWindows.get(id) ?? { start: 0, span: 1 };
  const monotonic = mapMonotonicProgress(latestProgress.get(id) ?? 0, progress, window);
  latestProgress.set(id, monotonic);
  post({
    type: 'progress',
    id,
    // A sub-engine finishing is not the whole mixed request finishing.
    stage: stage === 'done' && monotonic < 1 ? 'collecting' : stage,
    progress: monotonic,
  });
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Turns an error that escaped every `catch` into a reported failure.
 *
 * TensorFlow.js registers backends during module evaluation, and some of those
 * paths reference `window`, which does not exist in a worker. The resulting
 * `ReferenceError` is raised outside any promise this file awaits, so without
 * these two handlers the request simply never settles.
 */
function reportEscapedError(detail: string): void {
  // A model attempt is in progress: turn the escaped error into a rejection of
  // that attempt. Polyphonic evidence may not be silently reinterpreted by a
  // monophonic engine; the normal request catch reports the honest failure.
  const attempt = modelAttempt;
  if (attempt !== null) {
    modelAttempt = null;
    attempt.reject(new AppError('model_load_failed', 'retry', detail.slice(0, 120)));
    return;
  }

  const id = inFlight;
  if (id === null) return;
  inFlight = null;
  cancelled.add(id);
  post({
    type: 'error',
    id,
    code: 'transcription_failed',
    recovery: 'retry',
    detail: detail.slice(0, 200),
  });
}

/**
 * The in-progress Basic Pitch attempt, if any, and how to abandon it.
 * Set only while the model path is running.
 */
let modelAttempt: { reject(error: unknown): void } | null = null;

self.addEventListener('error', (event) => {
  reportEscapedError((event as ErrorEvent).message ?? 'worker error');
});

self.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason;
  reportEscapedError(reason instanceof Error ? reason.message : String(reason));
});

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  void handleTranscribe(request);
};

async function handleTranscribe(request: TranscribeRequest): Promise<void> {
  const audio: MonoAudio = {
    samples: request.samples,
    sampleRate: request.sampleRate,
    durationSec: request.durationSec,
  };

  inFlight = request.id;
  latestProgress.set(request.id, 0);
  progressWindows.set(request.id, { start: 0, span: 1 });
  try {
    let classification = request.mode === 'auto' ? classifyInput(audio) : null;
    if (classification?.type === 'unknown') {
      throw new AppError(
        'input_unrecognized',
        'rerecord',
        classification.reasoning.join('; ').slice(0, 200),
      );
    }
    const route = classification?.type ?? request.mode;
    const result = route === 'rhythm'
      ? await runRhythm(request, audio)
      : route === 'melody' || route === 'voice'
        ? await runVoiceMelody(request, audio)
        : route === 'mixed'
          ? await runMixed(request, audio)
          : await runInstrument(request, audio);

    /**
     * A multipitch result on material that barely used its second voice is
     * worth saying out loud. Sharp-articulated solo humming lands here: the
     * classifier reads the attacks as an instrument, the model obliges, and the
     * output scatters across registers the performer never sang. The review
     * screen offers a one-tap route correction; this warning is what makes the
     * offer discoverable instead of the user simply meeting a worse
     * transcription. Deliberately narrow: layered music routinely spans more
     * than two octaves *and* sustains real chords, and must never be nagged.
     */
    if (classification?.type === 'polyphonic' && result.notes.length > 0) {
      const pitches = result.notes.map((note) => note.pitch);
      const span = Math.max(...pitches) - Math.min(...pitches);
      const simultaneous = maximumSimultaneity(result.notes);
      if (span >= 26 && simultaneous <= 4) {
        result.diagnostics.warnings.push('multipitch_route_sparse_register_signature');
      }
    }

    if (classification) {
      classification = reconcileClassificationWithMaterial(
        classification,
        result.notes.length,
        result.drums?.length ?? 0,
      );
    }
    if (classification) result.diagnostics.classification = classification;

    if (cancelled.has(request.id)) {
      cancelled.delete(request.id);
      return;
    }
    post({ type: 'result', id: request.id, result });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError('transcription_failed', 'retry', error instanceof Error ? error.name : 'unknown');
    post({
      type: 'error',
      id: request.id,
      code: appError.code,
      recovery: appError.recovery,
      detail: appError.detail,
    });
  } finally {
    if (inFlight === request.id) inFlight = null;
    cancelled.delete(request.id);
    latestProgress.delete(request.id);
    progressWindows.delete(request.id);
  }
}

async function runMixed(
  request: TranscribeRequest,
  audio: MonoAudio,
): Promise<TranscriptionResult> {
  progressWindows.set(request.id, { start: 0, span: 0.75 });
  const pitched = await runInstrument(request, audio);
  throwIfCancelled(request.id);
  progressWindows.set(request.id, { start: 0.75, span: 0.25 });
  const rhythm = await runRhythm(request, audio);
  if (pitched.notes.length === 0 && (rhythm.drums?.length ?? 0) > 0) {
    return {
      ...rhythm,
      diagnostics: {
        ...rhythm.diagnostics,
        elapsedMs: pitched.diagnostics.elapsedMs + rhythm.diagnostics.elapsedMs,
        warnings: [
          ...pitched.diagnostics.warnings,
          ...rhythm.diagnostics.warnings,
          'mixed_pitch_branch_empty:rhythm_preserved',
        ],
      },
    };
  }
  return {
    ...pitched,
    drums: rhythm.drums ?? [],
    onsets: rhythm.onsets,
    diagnostics: {
      ...pitched.diagnostics,
      elapsedMs: pitched.diagnostics.elapsedMs + rhythm.diagnostics.elapsedMs,
      notesBeforeFilter:
        pitched.diagnostics.notesBeforeFilter + rhythm.diagnostics.notesBeforeFilter,
      notesAfterFilter:
        pitched.diagnostics.notesAfterFilter + rhythm.diagnostics.notesAfterFilter,
      warnings: [
        ...pitched.diagnostics.warnings,
        ...rhythm.diagnostics.warnings,
        'mixed_route:pitch_and_rhythm_preserved',
      ],
    },
  };
}

async function runRhythm(
  request: TranscribeRequest,
  audio: MonoAudio,
): Promise<TranscriptionResult> {
  const transcriber = new RhythmTranscriber();
  return transcriber.transcribe(
    audio,
    { mode: 'rhythm', onsetThreshold: request.onsetThreshold },
    (progress) =>
      reportProgress(request.id, progress.stage, progress.progress),
  );
}

/**
 * How long the model path gets before it is abandoned.
 *
 * ADR-001 gives the built-in tracker the job of covering a model failure, and
 * a hang is a failure - arguably the worst kind, because nothing is reported.
 * The budget scales with the clip because inference is proportional to it, and
 * it is deliberately loose: the PRD's target is 0.5x the clip duration, so
 * eight times that is not a performance assertion, it is a liveness one.
 */
function modelBudgetMs(durationSec: number): number {
  return Math.max(20_000, durationSec * 8_000);
}

/**
 * How long the register witness gets before the take proceeds without it.
 *
 * Deliberately tighter than `modelBudgetMs`. That budget covers the model the
 * instrument path *needs*, where a timeout means failing the request. This one
 * covers a second opinion the voice path can do without, so the right response
 * to it running long is to stop waiting rather than to lose the take.
 */
function witnessBudgetMs(durationSec: number): number {
  return Math.max(10_000, durationSec * 3_000);
}

/**
 * Basic Pitch's reading of a voice take, for the one question it is good at.
 *
 * Never throws. Every reason this can fail — the model is disabled, the weights
 * are not cached and the device is offline, TensorFlow cannot start in this
 * browser, inference runs long — is a reason to continue without a second
 * opinion, not a reason to lose a recording. The caller gets `null` and the
 * warning says which.
 */
async function registerWitness(
  request: TranscribeRequest,
  audio: MonoAudio,
  warnings: string[],
): Promise<EvidenceSource | null> {
  if (!request.allowModel) {
    warnings.push('register_witness_skipped:model_disabled');
    return null;
  }

  const started = now();
  try {
    const escapable = new Promise<never>((_, reject) => {
      modelAttempt = { reject };
    });
    const run = await withTimeout(
      Promise.race([
        basicPitchCandidates(request, audio, { load: 0.3, inferFrom: 0.35, inferSpan: 0.45 }),
        escapable,
      ]),
      witnessBudgetMs(audio.durationSec),
      'witness_timeout',
    );
    return {
      engineId: 'basic-pitch',
      view: 'original',
      notes: run.notes,
      elapsedMs: now() - started,
    };
  } catch (error) {
    // A cancelled request is not a witness failure; let the caller's own
    // cancellation check end the job.
    if (cancelled.has(request.id)) throw error;
    const detail = error instanceof AppError ? error.detail ?? error.code : 'unavailable';
    warnings.push(`register_witness_unavailable:${String(detail).slice(0, 40)}`);
    return null;
  } finally {
    modelAttempt = null;
  }
}

async function runVoiceMelody(
  request: TranscribeRequest,
  audio: MonoAudio,
  warnings: string[] = [],
  started = now(),
): Promise<TranscriptionResult> {
  reportProgress(request.id, 'preparing_audio', 0.08);
  const extraction = extractHumanMelody(audio, {
    segmentation: { minDurationSec: request.minNoteLengthSec },
  });
  throwIfCancelled(request.id);

  /**
   * The register decision, taken once, before anything reads the candidate.
   *
   * Order matters here. The contour engine's boundaries, voicing and pitch
   * classes are kept exactly as measured — it is the best engine in the corpus
   * at all three — and only the octave is reconsidered, against an engine
   * measured at 0% octave error on the case this one fails. Everything
   * downstream then reads a single settled register, which is what lets the
   * Judge keep deferring to it.
   */
  const witness = await registerWitness(request, audio, warnings);
  throwIfCancelled(request.id);
  const register = arbitrateRegister(extraction.notes, witness ? [witness] : []);
  const candidateNotes = register.notes;

  reportProgress(request.id, 'collecting', 0.86);

  // The Judge runs here, in the worker, and reuses the contour the melody
  // engine has already produced. Re-tracking the fundamental purely to check it
  // would roughly double the wait for no extra information.
  const onsetsSec = detectOnsets(audio.samples, audio.sampleRate).onsets.map(
    (onset) => onset.timeSec,
  );
  const sourcePhrase = buildMusicalPhraseModel(candidateNotes, {
    sourceKind: 'voice',
    frames: extraction.frames,
    onsetsSec,
  });
  const judgeFeatures = judgeFeaturesFromFrames(
    extraction.frames,
    audio.durationSec,
    onsetsSec,
  );
  // The candidate's register is itself a measured decision — the melody engine
  // voted with these frames, and where a second engine had better evidence
  // `arbitrateRegister` has already applied it — so octave repair defers and
  // reports instead of re-deciding. This is the single-octave-authority rule:
  // one stage owns the register, and a second opinion with less information
  // never overrules it. What changed is not the rule but who that stage is: it
  // is now an arbitration over independent measurements rather than one
  // engine's unchecked reading, which is why it can be trusted with more.
  const verdict = judgeAndRepair(sourcePhrase.sourceEvidence.notes, judgeFeatures, {
    repair: { respectCandidateRegister: true },
  });
  const phraseModel = buildMusicalPhraseModel(candidateNotes, {
    sourceKind: 'voice',
    interpretationNotes: verdict.judgedNotes,
    frames: extraction.frames,
    onsetsSec,
  });
  throwIfCancelled(request.id);

  reportProgress(request.id, 'done', 1);
  return {
    // The candidate is returned untouched; the repair travels beside it.
    notes: candidateNotes,
    phraseModel,
    referenceNotes: candidateNotes.map((note) => ({ ...note })),
    melodyQuality: extraction.quality,
    judge: {
      notes: verdict.judgedNotes,
      score: verdict.judgedScore.overall,
      scoreBefore: verdict.originalScore.overall,
      repairs: verdict.repairs.map((step) => step.description),
      unsupportedNotesRemoved: Math.max(
        0,
        verdict.originalScore.diagnostics.unsupportedNotes -
          verdict.judgedScore.diagnostics.unsupportedNotes,
      ),
      octaveErrorsCorrected: Math.max(
        0,
        verdict.originalScore.diagnostics.octaveMismatches -
          verdict.judgedScore.diagnostics.octaveMismatches,
      ),
      ...(verdict.octaveConflicts.length > 0 ? { octaveConflicts: verdict.octaveConflicts } : {}),
    },
    durationSec: audio.durationSec,
    diagnostics: {
      transcriberId: 'melody-extraction',
      backend: 'browser',
      elapsedMs: now() - started,
      modelLoadMs: 0,
      modelFromCache: true,
      notesBeforeFilter: extraction.frames.filter((frame) => frame.midiPitch !== null).length,
      notesAfterFilter: candidateNotes.length,
      warnings: [
        ...warnings,
        // What the second engine was asked, and what came back. Present even
        // when nothing moved: "a witness ran and agreed" and "no witness ran"
        // are different facts about how much the register can be trusted.
        ...(witness === null
          ? []
          : [
              `register_witness:${witness.engineId}:${witness.notes.length}notes:` +
                `${Math.round(witness.elapsedMs ?? 0)}ms`,
              `register_corrected:${register.corrected}`,
              ...(register.unresolved > 0 ? [`register_unresolved:${register.unresolved}`] : []),
              ...notableDecisions(register)
                .slice(0, 8)
                .map(
                  (decision) =>
                    `register_${decision.outcome}:@${decision.startSec.toFixed(2)}s ` +
                    `${decision.fromPitch}->${decision.toPitch} ${decision.reason}`,
                ),
            ]),
        ...(extraction.range
          ? [`adaptive_vocal_range:${extraction.range.lowMidi.toFixed(1)}-${extraction.range.highMidi.toFixed(1)}`]
          : []),
        ...(!extraction.quality.clear
          ? [`unclear_melody:${extraction.quality.melodyConfidence.toFixed(2)}`]
          : []),
        `phrase_continuity:${phraseModel.metrics.connectedTransitions}:` +
          `${phraseModel.metrics.reconstructedGapSec.toFixed(3)}s`,
        // A reported conflict is an unresolved question, not a repair: the
        // transcription kept its measured register while the frames under it
        // read an octave away. Surfaced here so downstream stages and the
        // debug views can see exactly where the take is register-ambiguous.
        ...verdict.octaveConflicts.slice(0, 12).map(
          (conflict) =>
            `octave_conflict:@${conflict.startSec.toFixed(2)}s note=${conflict.notePitch}` +
            ` frames=${conflict.referenceMedian} support=${conflict.noteSupport}/${conflict.referenceSupport}`,
        ),
        ...(verdict.octaveConflicts.length > 12
          ? [`octave_conflicts_total:${verdict.octaveConflicts.length}`]
          : []),
      ],
      // The mechanical record of what the later stages did to the candidate,
      // bounded, for the debug views: when a take comes out wrong, the first
      // question is which stage changed what.
      noteTransformations: [
        // The register arbitration is a stage that moves notes, so it is
        // recorded as one. Leaving it out would make the Judge look responsible
        // for octave changes it did not make.
        ...noteTransformations('register', extraction.notes, candidateNotes),
        ...noteTransformations('judge', candidateNotes, verdict.judgedNotes),
        ...noteTransformations('interpretation', candidateNotes, phraseModel.interpretedNotes),
      ].slice(0, 200),
    },
  };
}

async function runInstrument(
  request: TranscribeRequest,
  audio: MonoAudio,
): Promise<TranscriptionResult> {
  const melodyStarted = now();
  if (request.allowModel) {
    try {
      // `escapable` is rejected by the global error trap, so an error thrown
      // from inside the library's own module graph still ends this attempt.
      const escapable = new Promise<never>((_, reject) => {
        modelAttempt = { reject };
      });
      return await withTimeout(
        Promise.race([runBasicPitch(request, audio, melodyStarted), escapable]),
        modelBudgetMs(audio.durationSec),
        'model_timeout',
      );
    } catch (error) {
      if (cancelled.has(request.id)) throw error;
      throw error instanceof AppError
        ? error
        : new AppError('model_load_failed', 'retry', 'polyphonic model unavailable', { cause: error });
    } finally {
      modelAttempt = null;
    }
  }
  throw new AppError('model_load_failed', 'retry', 'polyphonic model disabled');
}

interface BasicPitchModule {
  BasicPitch: new (modelPath: string) => {
    evaluateModel(
      buffer: Float32Array,
      onComplete: (frames: number[][], onsets: number[][], contours: number[][]) => void,
      onPercent: (percent: number) => void,
    ): Promise<void>;
  };
  outputToNotesPoly(
    frames: number[][],
    onsets: number[][],
    onsetThresh?: number,
    frameThresh?: number,
    minNoteLen?: number,
    inferOnsets?: boolean,
    maxFreq?: number | null,
    minFreq?: number | null,
    melodiaTrick?: boolean,
    energyTolerance?: number,
  ): Array<{
    startFrame: number;
    durationFrames: number;
    pitchMidi: number;
    amplitude: number;
  }>;
  noteFramesToTime(
    notes: Array<{ startFrame: number; durationFrames: number; pitchMidi: number; amplitude: number }>,
  ): Array<{
    startTimeSeconds: number;
    durationSeconds: number;
    pitchMidi: number;
    amplitude: number;
  }>;
}

/**
 * One Basic Pitch inference, without deciding what the answer is *for*.
 *
 * Split out of `runBasicPitch` because the voice path needs the same notes for
 * an entirely different purpose — a register witness rather than a
 * transcription — and running two subtly different copies of a model call is
 * how the two would eventually disagree about something nobody tested.
 */
interface BasicPitchRun {
  notes: NoteEvent[];
  /** Before the empty-note filter, for the diagnostics count. */
  rawCount: number;
  modelLoadMs: number;
  fromCache: boolean;
}

async function basicPitchCandidates(
  request: TranscribeRequest,
  audio: MonoAudio,
  progress: { load: number; inferFrom: number; inferSpan: number },
): Promise<BasicPitchRun> {
  reportProgress(request.id, 'loading_model', progress.load);

  const modelLoadStart = now();
  prepareWorkerGlobalsForTensorflow();
  // Not named `module`: Next refuses to bundle an assignment to that
  // identifier, since it collides with the CommonJS wrapper.
  let basicPitch: BasicPitchModule;
  try {
    basicPitch = (await import('@spotify/basic-pitch')) as unknown as BasicPitchModule;
  } catch (error) {
    throw new AppError('model_load_failed', 'retry', 'import failed', { cause: error });
  }

  const fromCache = cachedModel?.url === request.modelUrl;
  let instance: InstanceType<BasicPitchModule['BasicPitch']>;
  try {
    if (fromCache) {
      instance = cachedModel?.instance as InstanceType<BasicPitchModule['BasicPitch']>;
    } else {
      instance = new basicPitch.BasicPitch(request.modelUrl);
      cachedModel = { url: request.modelUrl, instance };
    }
  } catch (error) {
    cachedModel = null;
    throw new AppError('model_load_failed', 'retry', 'model init', { cause: error });
  }
  const modelLoadMs = fromCache ? 0 : now() - modelLoadStart;

  reportProgress(request.id, 'preparing_audio', progress.inferFrom);
  // The model has a fixed input rate. Resampling here, visibly, beats letting
  // the wrapper do it invisibly and then wondering why timings drifted.
  const prepared = peakNormalize(resample(audio, MODEL_SAMPLE_RATE));
  throwIfCancelled(request.id);

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  try {
    await instance.evaluateModel(
      prepared.samples,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      (percent) => {
        reportProgress(
          request.id,
          'inferring',
          progress.inferFrom + Math.max(0, Math.min(1, percent)) * progress.inferSpan,
        );
      },
    );
  } catch (error) {
    throw new AppError('transcription_failed', 'retry', 'inference', { cause: error });
  }
  throwIfCancelled(request.id);

  const raw = basicPitch.outputToNotesPoly(
    frames,
    onsets,
    request.onsetThreshold,
    request.noteThreshold,
    // The library counts note length in model frames, not seconds.
    Math.max(1, Math.round(request.minNoteLengthSec / MODEL_FRAME_SEC)),
    true,
    null,
    null,
    false,
  );
  const timed = basicPitch.noteFramesToTime(raw);

  const candidates: NoteEvent[] = timed
    .map((note) => ({
      startSec: note.startTimeSeconds,
      endSec: note.startTimeSeconds + note.durationSeconds,
      pitch: Math.round(note.pitchMidi),
      // Basic Pitch reports amplitude 0..1; the note contract wants velocity.
      velocity: Math.max(25, Math.min(127, Math.round(note.amplitude * 127))),
      confidence: Math.max(0, Math.min(1, note.amplitude)),
    }))
    .filter((note) => note.endSec > note.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  return { notes: candidates, rawCount: timed.length, modelLoadMs, fromCache };
}

async function runBasicPitch(
  request: TranscribeRequest,
  audio: MonoAudio,
  started: number,
): Promise<TranscriptionResult> {
  const run = await basicPitchCandidates(request, audio, {
    load: 0.02,
    // The model's own percentage covers 15%..85% of the whole job.
    inferFrom: 0.15,
    inferSpan: 0.7,
  });
  const notes = run.notes;

  reportProgress(request.id, 'collecting', 0.9);
  reportProgress(request.id, 'done', 1);

  const diagnostics: ProcessingDiagnostics = {
    transcriberId: 'basic-pitch',
    backend: 'browser',
    elapsedMs: now() - started,
    modelLoadMs: run.modelLoadMs,
    modelFromCache: run.fromCache,
    notesBeforeFilter: run.rawCount,
    notesAfterFilter: notes.length,
    warnings: [],
  };

  return {
    notes,
    phraseModel: buildMusicalPhraseModel(notes, { sourceKind: 'polyphonic' }),
    // Audio has no independent polyphonic ground truth. The Judge therefore
    // acts as a fidelity guard: it validates the candidate structurally and
    // abstains from monophonic pitch repair, which would destroy chords.
    judge: polyphonicFidelityVerdict(notes),
    durationSec: audio.durationSec,
    diagnostics,
  };
}

function polyphonicFidelityVerdict(notes: readonly NoteEvent[]): NonNullable<TranscriptionResult['judge']> {
  const confidence = notes.length === 0
    ? 0
    : notes.reduce((sum, note) => sum + (note.confidence ?? 0.75), 0) / notes.length;
  return {
    notes: notes.map((note) => ({ ...note })),
    score: Math.max(0, Math.min(1, confidence)),
    scoreBefore: Math.max(0, Math.min(1, confidence)),
    repairs: [],
    unsupportedNotesRemoved: 0,
    octaveErrorsCorrected: 0,
  };
}

/**
 * Makes a worker look enough like a document for TensorFlow.js to load.
 *
 * `@spotify/basic-pitch` depends on TensorFlow.js 3.21, whose WebGL backend
 * reads `window` while its module is being evaluated. A worker has no `window`,
 * only `self`, so the import throws `ReferenceError: window is not defined` -
 * and it throws from inside the library's own module graph, where nothing this
 * file wrote is on the stack to catch it.
 *
 * Aliasing `window` to the worker's global scope is the smallest change that
 * lets the library initialise. It is a shim around a third-party assumption,
 * kept to one function and applied lazily, immediately before the import that
 * needs it, so nothing else in the worker is affected by it.
 *
 * If TensorFlow.js still cannot start, the caller falls back to the built-in
 * pitch tracker; this makes the model path possible, it does not make it
 * required.
 */
function prepareWorkerGlobalsForTensorflow(): void {
  const scope = globalThis as Record<string, unknown>;
  if (scope.window === undefined) scope.window = globalThis;
}

/** Basic Pitch emits one frame every 256 samples at 22.05 kHz. */
const MODEL_FRAME_SEC = 256 / MODEL_SAMPLE_RATE;

/** How many voices ever sound at once in a candidate set. */
function maximumSimultaneity(notes: readonly NoteEvent[]): number {
  const points = notes.flatMap((note) => [
    { time: note.startSec, delta: 1 },
    { time: note.endSec, delta: -1 },
  ]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

/**
 * Rejects if `work` has not settled in time.
 *
 * The abandoned promise is left to finish in the background; there is no way to
 * cancel work inside a third-party library, and attaching a no-op catch stops
 * its eventual rejection from being reported as unhandled.
 */
function withTimeout<T>(work: Promise<T>, ms: number, detail: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppError('model_load_failed', 'retry', detail));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function throwIfCancelled(id: string): void {
  if (cancelled.has(id)) throw new AppError('transcription_cancelled', 'none', 'cancelled');
}
