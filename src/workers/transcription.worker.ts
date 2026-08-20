/// <reference lib="webworker" />

/**
 * US-0303 - transcription off the main thread.
 *
 * The worker owns the whole heavy half of the pipeline: model load, inference,
 * and for the rhythm path onset detection and classification. The main thread
 * only ever sees typed messages.
 *
 * Two engines live behind one protocol:
 *
 *   basic-pitch    the PRD's primary path. Loaded by dynamic import so its
 *                  TensorFlow.js dependency is not in the initial bundle and
 *                  is never fetched by a user who does not record.
 *   pitch-tracker  the built-in YIN tracker. Pure TypeScript, no model, and
 *                  the automatic fallback when the model cannot be loaded or
 *                  the backend will not initialise.
 *
 * The fallback is honest, not silent: the result carries `transcriberId`, the
 * UI shows which engine produced it, and a `model_unavailable` warning is
 * attached to the diagnostics.
 */

import {
  AppError,
  type MonoAudio,
  type NoteEvent,
  type ProcessingDiagnostics,
  type TranscriptionResult,
} from '@contracts';
import { peakNormalize, resample } from '@/packages/audio-core/normalize';
import { PitchTrackerTranscriber, RhythmTranscriber } from '@/packages/audio-core/transcribers';

export interface TranscribeRequest {
  type: 'transcribe';
  id: string;
  mode: 'melody' | 'rhythm';
  /** Transferred, not copied. */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  modelUrl: string;
  /** `false` forces the built-in tracker, used by the design catalog and tests. */
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

/** Cached across takes so a second recording does not reload the model. */
let cachedModel: { url: string; instance: unknown } | null = null;

const post = (message: WorkerResponse): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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

  try {
    const result =
      request.mode === 'rhythm'
        ? await runRhythm(request, audio)
        : await runMelody(request, audio);

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
    cancelled.delete(request.id);
  }
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
      post({ type: 'progress', id: request.id, stage: progress.stage, progress: progress.progress }),
  );
}

async function runMelody(
  request: TranscribeRequest,
  audio: MonoAudio,
): Promise<TranscriptionResult> {
  if (request.allowModel) {
    try {
      return await runBasicPitch(request, audio);
    } catch (error) {
      // Falling through to the tracker is the whole point of having one, but
      // a cancelled run must not be "recovered" into a second inference.
      if (cancelled.has(request.id)) throw error;
      const detail = error instanceof AppError ? error.detail : 'load failed';
      return runPitchTracker(request, audio, [`model_unavailable:${detail ?? 'unknown'}`]);
    }
  }
  return runPitchTracker(request, audio, []);
}

async function runPitchTracker(
  request: TranscribeRequest,
  audio: MonoAudio,
  warnings: string[],
): Promise<TranscriptionResult> {
  const transcriber = new PitchTrackerTranscriber();
  const result = await transcriber.transcribe(
    audio,
    {
      mode: 'melody',
      noteThreshold: request.noteThreshold > 0 ? request.noteThreshold : undefined,
      minNoteLengthSec: request.minNoteLengthSec,
    },
    (progress) =>
      post({ type: 'progress', id: request.id, stage: progress.stage, progress: progress.progress }),
  );
  return {
    ...result,
    diagnostics: { ...result.diagnostics, warnings: [...result.diagnostics.warnings, ...warnings] },
  };
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

async function runBasicPitch(
  request: TranscribeRequest,
  audio: MonoAudio,
): Promise<TranscriptionResult> {
  const started = now();
  post({ type: 'progress', id: request.id, stage: 'loading_model', progress: 0.02 });

  const modelLoadStart = now();
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

  post({ type: 'progress', id: request.id, stage: 'preparing_audio', progress: 0.12 });
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
        post({
          type: 'progress',
          id: request.id,
          stage: 'inferring',
          // The model's own percentage covers 15%..85% of the whole job.
          progress: 0.15 + Math.max(0, Math.min(1, percent)) * 0.7,
        });
      },
    );
  } catch (error) {
    throw new AppError('transcription_failed', 'retry', 'inference', { cause: error });
  }
  throwIfCancelled(request.id);

  post({ type: 'progress', id: request.id, stage: 'collecting', progress: 0.9 });

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
    true,
  );
  const timed = basicPitch.noteFramesToTime(raw);

  const notes: NoteEvent[] = timed
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

  post({ type: 'progress', id: request.id, stage: 'done', progress: 1 });

  const diagnostics: ProcessingDiagnostics = {
    transcriberId: 'basic-pitch',
    backend: 'browser',
    elapsedMs: now() - started,
    modelLoadMs,
    modelFromCache: fromCache,
    notesBeforeFilter: timed.length,
    notesAfterFilter: notes.length,
    warnings: [],
  };

  return { notes, durationSec: audio.durationSec, diagnostics };
}

/** Basic Pitch emits one frame every 256 samples at 22.05 kHz. */
const MODEL_FRAME_SEC = 256 / MODEL_SAMPLE_RATE;

function throwIfCancelled(id: string): void {
  if (cancelled.has(id)) throw new AppError('transcription_cancelled', 'none', 'cancelled');
}
