'use client';

/**
 * The creation flow's state.
 *
 * One reducer, one machine, one place where the audio side effects are ordered.
 * Components below this read a snapshot and call actions; none of them own
 * audio state, which is what stops the "unrelated booleans" failure mode the
 * playbook warns about.
 *
 * Effects that are genuinely imperative - opening the microphone, running the
 * worker, rendering offline - live in refs rather than state, because they are
 * resources with lifetimes rather than values.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  AppError,
  DEFAULT_METER,
  LOCAL_SCHEMA_VERSION,
  toAppError,
  type AudioValidation,
  type InputClassification,
  type Locale,
  type LocalSourceAsset,
  type JudgeVerdict,
  type MelodyConfidence,
  type Meter,
  type MonoAudio,
  type NoteEvent,
  type ProcessingDiagnostics,
  type TranscriptionProgress,
} from '@contracts';
import { correctClassification } from '@intent';
import {
  closeMicrophone,
  decodeToMono,
  getAudioContext,
  openMicrophone,
  startRecording,
  unlockAudio,
  validateAudio,
  type ActiveRecording,
  type CaptureStream,
  type LevelSnapshot,
} from '@audio-core';
import { refine, RETOUCH_AMOUNT_DEFAULT, type RefineResult } from '@retouch';
import { teach, type TeacherResult } from '@music-teacher';
import {
  analyzeDrumRhythm,
  analyzeMelodyRhythm,
  defaultVersion,
  encodingBpm,
  planVersions,
  resolveVersionTempo,
  type PerformanceRhythm,
  type PerformanceTempo,
  type VersionId,
  type VersionRecipe,
} from '@rhythm-extraction';
import {
  toStoredMusician,
  useMusicianAvailability,
  useMusicianJob,
  type MusicianJobSnapshot,
  type MusicianPair,
} from '@/features/musician';
import {
  describeVersion,
  isMusicianVersion,
  notesForVersion,
  offerableGenerated,
  renderCacheKey,
  type MusicalVersionId,
  type VersionNoteSources,
} from '@versions';
import { buildMusicianRequest as assembleMusicianRequest, type MusicianRequest } from '@musician-client';
import { importMidi, planMidiImport, type MidiImportResult } from '@midi';
import {
  DEFAULT_MASTER,
  musicalDurationSec,
  playSketch,
  renderSketch,
  resolveInstrument,
  type MasterSettings,
  type PlaybackHandle,
} from '@synthesis';
import { transcribe } from '@/features/transcription/client';
import { buildMusicalPhraseModel } from '@/packages/musical-phrase';
import { track } from '@/features/analytics/track';
import {
  INITIAL_CONTEXT,
  transition,
  type CreationEvent,
  type MachineContext,
} from '@/features/state/machine';
import { newSketchId, saveSketch } from '@/features/workspace/db';

/** PRD R-05, questionnaire Q-B1: sixty seconds. */
export const MAX_RECORDING_SEC = 60;
export const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_MIDI_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * The state, the reducer and the source-isolation rule all live in `state.ts`.
 *
 * Re-exported here because a dozen components import `FlowState` from this
 * module, and moving the type was not the point of the change that moved it.
 */
export type { Action, FlowState, MelodyInputMode } from './state';
import { initialState, reducer, type FlowState } from './state';

export function useCreationFlow(locale: Locale) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(newSketchId()));
  const sourceKind = state.source?.kind;
  const inputType = state.diagnostics?.classification?.type;

  const captureRef = useRef<CaptureStream | null>(null);
  const recorderRef = useRef<ActiveRecording | null>(null);
  const playbackRef = useRef<PlaybackHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startTimerRef = useRef<number | null>(null);

  const send = useCallback((event: CreationEvent) => dispatch({ type: 'machine', event }), []);

  const fail = useCallback((error: unknown) => {
    const appError = toAppError(error);
    dispatch({ type: 'error', error: appError });
    dispatch({
      type: 'machine',
      event: 'FAIL',
      payload: { code: appError.code, recovery: appError.recovery },
    });
    track('error', { code: appError.code });
  }, []);

  /**
   * What the performance itself says about tempo, meter and groove.
   *
   * Derived from the take, and now from nothing else. Recomputed only when the
   * transcription changes, because it describes the recording rather than any
   * of the choices made about it afterwards.
   */
  const rhythm = useMemo<PerformanceRhythm | null>(() => {
    if (state.durationSec <= 0) return null;
    if (state.mode === 'rhythm') {
      return state.rawDrums.length > 0
        ? analyzeDrumRhythm(state.rawDrums, state.durationSec)
        : null;
    }
    // Judged notes where available: a harmonic artifact and a fragmented note
    // are not attacks, and letting them vote on the tempo skews it.
    const notes = state.judge?.notes ?? state.rawNotes;
    return notes.length > 0 ? analyzeMelodyRhythm(notes, state.durationSec) : null;
  }, [state.mode, state.rawNotes, state.judge, state.rawDrums, state.durationSec]);

  /**
   * The tempo the music is interpreted at, if it has one.
   *
   * The single answer to "what tempo is this?", resolved once here and used by
   * every consumer — the version recipes, the Musician request, the exported
   * MIDI, the piano roll's bar lines. They previously each re-derived it from
   * `rhythm.reliable`, which is how the Musician could be asked for one tempo
   * while the picker displayed another.
   *
   * There is exactly one input now, and it is the recording. Nothing the user
   * did before they made a sound can reach this.
   */
  const performanceTempo = useMemo<PerformanceTempo>(
    () => resolveVersionTempo({ rhythm }),
    [rhythm],
  );

  /**
   * The BPM to *write down* — MIDI tempo, bar rulers, the synthesis grid.
   *
   * Separate from `performanceTempo.bpm` because those consumers need a number
   * even when the performance had no pulse, and a constant stand-in is the only
   * honest way to give them one. Nothing musical follows from it: with
   * `freeTiming` set, every version's quantization strength is zero, so no note
   * is moved toward the grid this implies.
   */
  const encodedBpm = useMemo(() => encodingBpm(performanceTempo), [performanceTempo]);

  /**
   * What a teacher would suggest, computed from the Judge's reading.
   *
   * Derived rather than stored, and keyed only on the judged notes, so it runs
   * once per take. It deliberately receives no tempo at all: the Teacher works
   * from the performance's own timing.
   */
  const lesson = useMemo<TeacherResult | null>(() => {
    if (state.mode !== 'melody') return null;
    const source = state.phraseModel?.interpretedNotes ?? state.judge?.notes ?? state.rawNotes;
    if (source.length < 4 || state.durationSec <= 0) return null;
    try {
      return teach(source, state.durationSec);
    } catch {
      // The Teacher is pure; a throw means malformed input rather than a
      // transient fault, and losing the suggestion is better than losing the
      // sketch.
      return null;
    }
  }, [state.mode, state.phraseModel, state.judge, state.rawNotes, state.durationSec]);

  const musicianAvailability = useMusicianAvailability();

  /**
   * Musician state as it will be written to the workspace.
   *
   * Held in a ref rather than reducer state on purpose: it changes only when a
   * generation finishes, it is read only at save time, and putting it in state
   * would re-render the whole creation screen every time a poll advanced the
   * phase. The user is listening to music while this happens.
   */
  const musicianPersistRef = useRef<
    { sourceId: string; result: MusicianPair | null; job: MusicianJobSnapshot } | null
  >(null);
  const handleMusicianPersist = useCallback(
    (next: { result: MusicianPair | null; job: MusicianJobSnapshot }) => {
      musicianPersistRef.current = { sourceId: state.sourceId, ...next };
    },
    [state.sourceId],
  );



  /**
   * The Musician, if this deployment has one.
   *
   * Deliberately mounted here rather than inside the review screen: the job has
   * to outlive any one render of that screen, so leaving and returning does not
   * abandon a generation in flight (§2).
   *
   * `restore` is not wired to a saved sketch because the product has no
   * reopen-for-editing flow -- the workspace lists, renames, exports and
   * deletes. The hook supports restoration and it is covered by unit test, so
   * the day that flow is added this becomes one argument rather than a
   * redesign.
   */
  const musician = useMusicianJob({
    enabled: musicianAvailability.available,
    // Scoped to the evidence, not to the sketch. Record again or import a file
    // and the previous source's generations stop existing, rather than being
    // filtered out later by a digest check that only notices afterwards.
    sourceId: state.sourceId,
    onPersist: handleMusicianPersist,
  });

  /**
   * The Teacher material as it stands right now.
   *
   * Read out here rather than only inside `versionNoteSources` because it is
   * what the Musician's stored versions are checked against, and the check has
   * to happen before the picker is built.
   */
  const teacherNotes = useMemo<readonly NoteEvent[]>(
    () => lesson?.notes ?? state.phraseModel?.interpretedNotes ?? state.judge?.notes ?? state.rawNotes,
    [lesson, state.phraseModel, state.judge, state.rawNotes],
  );

  /**
   * The Musician's versions that may still be offered.
   *
   * Two filters, for two different lies the picker would otherwise tell.
   *
   * **Stale.** The three derived versions are recomputed from the transcription
   * on every render, so they always describe the current take. The Musician's
   * three are stored note data that cannot be recomputed. Move the cleanup
   * slider, re-run the Judge, reprocess the audio — the Teacher changes and the
   * stored versions do not, yet they stay in the picker still described as
   * "your idea, shaped". They have become a variation on a phrase that no longer
   * exists, presented as a variation on the one that does, and nothing about it
   * looks wrong: the notes are valid and the audio plays.
   *
   * **Refused.** `source_fallback` means no candidate survived the Identity
   * Guard and the service returned the Teacher's own notes. Offering that is the
   * exact failure the guard exists to prevent — the Teacher presented as the
   * Musician's work — arriving through the front door.
   *
   * Neither is deleted. The stored record keeps its digest and its flag, so what
   * happened stays inspectable and the panel can say which of the two occurred.
   */
  const offerable = useMemo(
    () => offerableGenerated(
      musician.generated,
      teacherNotes,
      state.phraseModel?.phrases.map((phrase) => ({
        startIndex: phrase.startNoteIndex,
        endIndex: phrase.endNoteIndex,
      })) ?? [],
    ),
    [musician.generated, teacherNotes, state.phraseModel],
  );
  const offeredGenerated = offerable.offered;

  /** Why a generated version is missing, so the panel can say so rather than just omit it. */
  const musicianWithheld = offerable.withheld;

  /** The versions on offer. The original performance is always one of them. */
  const versions = useMemo<VersionRecipe[]>(() => {
    if (rhythm === null) return [];
    return planVersions({
      rhythm,
      mode: state.mode,
      amount: state.retouchAmount,
      // Only versions whose notes actually exist are offered, so the picker can
      // never show something that cannot be played.
      generated: Object.keys(offeredGenerated) as MusicalVersionId[],
    });
  }, [rhythm, state.mode, state.retouchAmount, offeredGenerated]);

  /** The version in effect: the user's choice, or the honest default. */
  const activeVersion = useMemo<VersionRecipe | null>(() => {
    if (versions.length === 0) return null;
    const wanted = state.versionId ?? (rhythm ? defaultVersion(rhythm, state.mode) : 'grid');
    const chosen = versions.find((version) => version.id === wanted);
    if (chosen) return chosen;

    // The selection has gone away. That used to be impossible -- the generated
    // set only ever grew -- and is now routine: a Musician version is withheld
    // the moment the Teacher moves underneath it. Falling through to
    // `versions[0]` would drop the user on `unprocessed`, the rawest take, which
    // is a strange place to land after editing a *tidied* one.
    //
    // The registry already records what each version was derived from, so the
    // material the withheld reading was a reading *of* is the answer.
    const parent = isMusicianVersion(wanted) ? describeVersion(wanted).sourceVersionId : null;
    return (
      (parent ? versions.find((version) => version.id === parent) : undefined) ??
      versions.find((version) => version.id === (rhythm ? defaultVersion(rhythm, state.mode) : 'grid')) ??
      versions[0] ??
      null
    );
  }, [versions, state.versionId, rhythm, state.mode]);

  /**
   * Every version's notes, in one place.
   *
   * The three derived versions are computed here because they are cheap and
   * exact; the Musician's two are looked up because they cannot be recomputed.
   * `notesForVersion` reads from this and is the only thing that needs to know
   * the difference.
   */
  const versionNoteSources = useMemo<VersionNoteSources>(() => {
    const judged = state.phraseModel?.interpretedNotes ?? state.judge?.notes ?? state.rawNotes;
    return {
      unprocessed: state.rawNotes,
      judge: judged,
      teacher: teacherNotes,
      // The filtered set, not the raw one. The picker and the note resolver have
      // to agree: offering a version the resolver would answer for, or resolving
      // one the picker withheld, is how a withheld version gets played anyway.
      generated: offeredGenerated,
    };
  }, [state.rawNotes, state.phraseModel, state.judge, teacherNotes, offeredGenerated]);

  /**
   * The payload for a Musician request.
   *
   * **Teacher material only** (AC-02). The registry records that
   * `musician-refined` and `musician-developed` both descend from `teacher`,
   * and this reads the Teacher's notes through the same resolver every other
   * version goes through -- so the claim is enforced by the same code path
   * rather than by this function remembering to be careful.
   *
   * There is no branch here that could reach `state.audio`, and
   * `MusicianRequest` has no field that could carry it (AC-03).
   */
  /**
   * The latest retouch result, readable before it is declared.
   *
   * `refined` is computed further down and `buildMusicianRequest` needs its
   * detected key. Reordering the two would mean moving a large memo above the
   * things it depends on; a ref kept in sync is the smaller change and makes
   * the direction of the dependency obvious.
   */
  const refinedRef = useRef<RefineResult | null>(null);

  const buildMusicianRequest = useCallback((): MusicianRequest | null => {
    // Resolved once, in one place, and handed over already decided. The builder
    // has no access to any other tempo, so the substitution this bug was made
    // of cannot be reintroduced there.
    const analysis = refinedRef.current?.analysis ?? null;
    return assembleMusicianRequest({
      // The evidence, not the sketch: two takes of one sketch are two different
      // things to ask the model about, and the seed is derived from this.
      sourceId: state.sourceId,
      versionNotes: versionNoteSources,
      phrases: state.phraseModel?.phrases.map((phrase) => ({
        startIndex: phrase.startNoteIndex,
        endIndex: phrase.endNoteIndex,
      })) ?? [],
      // The service needs a number to condition on. A free-timed take supplies
      // the encoding constant with a confidence of zero, which is the truthful
      // pair: here is what to write down, and here is how much it means.
      tempo: {
        bpm: encodedBpm,
        confidence: performanceTempo.freeTiming ? 0 : performanceTempo.confidence,
      },
      meter: { beatsPerBar: state.meter.beatsPerBar, beatUnit: state.meter.beatUnit },
      key: analysis
        ? {
            tonic: analysis.keyRoot,
            mode: analysis.keyMode === 'minor' ? 'minor' : 'major',
            confidence: analysis.keyConfidence,
          }
        : null,
      // The *source* duration. This is the span the Teacher material occupies
      // and what the service's Identity Guard measures a candidate against; it
      // is not a budget for the result, which Expanded is meant to exceed.
      sourceDurationSec: state.durationSec,
    });
  }, [
    versionNoteSources,
    state.phraseModel,
    state.sourceId,
    state.meter,
    state.durationSec,
    encodedBpm,
    performanceTempo,
  ]);

  /** The refined result. Pure and cheap, so it is derived rather than stored. */
  const refined = useMemo<RefineResult | null>(() => {
    if (state.rawNotes.length === 0 && state.rawDrums.length === 0) return null;
    const instrument = resolveInstrument(state.instrumentId, state.mode);
    try {
      // Which notes a version is built from is part of what the version *is*.
      // Unprocessed shows the candidate exactly as it arrived; the Judge and
      // the Teacher both build on the repaired reading, because tidying notes
      // that still contain a harmonic artifact only produces a tidy mistake.
      // The Musician's two readings carry their own notes, which came back from
      // the service and cannot be recomputed here.
      //
      // Resolution goes through the registry rather than another chain of
      // ternaries, so adding a version later is one entry in one table.
      const sourceNotes =
        notesForVersion(activeVersion?.id ?? 'unprocessed', versionNoteSources) ??
        versionNoteSources.unprocessed;

      return refine(
        { notes: sourceNotes, drums: state.rawDrums },
        {
          // The grid this implies is only ever applied when the performance
          // actually had a pulse; a free-timed version carries zero timing
          // strength, so the encoding constant moves nothing.
          bpm: activeVersion?.bpm ?? encodedBpm,
          mode: state.mode,
          amount: activeVersion?.amount ?? state.retouchAmount,
          paramOverrides: activeVersion?.paramOverrides,
          keyOverride: state.keyOverride
            ? {
                root: state.keyOverride.root as never,
                mode: state.keyOverride.mode,
              }
            : undefined,
          playableRange: state.mode === 'melody' ? instrument.range : undefined,
          referenceNotes: state.referenceNotes,
          sourceKind,
          preserveRhythm: inputType === 'mixed',
        },
      );
    } catch {
      // Retouch is pure; a throw here means malformed input, not a transient
      // failure. Returning null shows the empty-result state instead of a crash.
      return null;
    }
  }, [
    encodedBpm,
    state.rawNotes,
    state.referenceNotes,
    state.rawDrums,
    state.mode,
    state.retouchAmount,
    state.keyOverride,
    state.instrumentId,
    inputType,
    sourceKind,
    activeVersion,
    versionNoteSources,
  ]);

  useEffect(() => {
    refinedRef.current = refined;
  }, [refined]);

  /**
   * How long the version being listened to actually lasts.
   *
   * Not `state.durationSec`. That is how long the person hummed, and the two are
   * different quantities that happened to be close enough to share a variable
   * until the Musician arrived. Expanded is explicitly allowed to grow the idea:
   * a real 10.14 s take came back as a 38.74 s passage, and because playback,
   * the offline render, the piano roll and the render key all read the source
   * duration, the exported WAV was 12.14 s — the recording's length plus the
   * release tail — and the last twenty-six seconds of the piece simply were not
   * there. No error, no warning, just a short file.
   *
   * The source duration stays in the calculation as a floor, so a take with
   * silence after its last note still plays its full length, which is what every
   * derived version already did.
   */
  const musicalDuration = useMemo(
    () => musicalDurationSec(refined?.notes ?? [], refined?.drums ?? [], state.durationSec),
    [refined, state.durationSec],
  );

  /**
   * Everything a render depends on, as one string.
   *
   * `renderCacheKey` supplies the version's own identity — for a generated
   * version that includes the job, the seed, the model revisions and a digest of
   * its notes, which is what makes one Musician result distinguishable from the
   * next. The rest is added here because `renderSketch` reads it and the
   * registry cannot see it: the master chain, the sketch duration and the drum
   * track.
   *
   * Null while there is nothing to render, which is not the same as "the render
   * is current" — see `renderedAudio` below, where null never matches.
   */
  const renderKey = useMemo<string | null>(() => {
    if (!refined) return null;
    return [
      renderCacheKey(activeVersion?.id ?? 'unprocessed', versionNoteSources, {
        instrumentId: state.instrumentId,
        bpm: activeVersion?.bpm ?? encodedBpm,
        retouchAmount: activeVersion?.amount ?? state.retouchAmount,
      }),
      // The rendered length, not the recorded one: two versions of one take
      // that differ only in how long they run must not share a render.
      musicalDuration.toFixed(3),
      state.master.volume.toFixed(3),
      state.master.reverb.toFixed(3),
      refined.drums.length,
    ].join('|');
  }, [
    refined,
    activeVersion,
    versionNoteSources,
    state.instrumentId,
    encodedBpm,
    state.retouchAmount,
    musicalDuration,
    state.master,
  ]);

  /**
   * The rendered WAV, but only while it is a render of what is on screen.
   *
   * Derived rather than dispatched. An effect that nulls stale audio leaves one
   * render in which the stale blob is still readable, and the thing reading it
   * is the export button — the single place where being one render behind means
   * shipping the wrong file. Comparing on read has no such window.
   */
  const renderedAudio = useMemo(
    () => (state.renderedKey !== null && state.renderedKey === renderKey ? state.renderedAudio : null),
    [state.renderedAudio, state.renderedKey, renderKey],
  );

  /** The key as of *now*, for the stamp written after an await. */
  const renderKeyRef = useRef<string | null>(null);
  useEffect(() => {
    renderKeyRef.current = renderKey;
  }, [renderKey]);

  const versionNotes = useMemo<Record<string, readonly NoteEvent[]>>(() => {
    const out: Record<string, readonly NoteEvent[]> = {};
    for (const version of versions) {
      const notes = notesForVersion(version.id, versionNoteSources);
      if (notes && notes.length > 0) out[version.id] = notes;
    }
    return out;
  }, [versions, versionNoteSources]);

  const versionProvenance = useMemo<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    // Keyed off the offered set so an export's provenance manifest describes
    // exactly the versions the export contains.
    for (const [id, generated] of Object.entries(offeredGenerated)) {
      if (generated) out[id] = generated.provenance;
    }
    return out;
  }, [offeredGenerated]);

  // --- Recording ---------------------------------------------------------

  const stopEverything = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    if (captureRef.current) {
      closeMicrophone(captureRef.current);
      captureRef.current = null;
    }
  }, []);

  // --- Transcription -----------------------------------------------------

  const runTranscription = useCallback(
    async (
      audio: MonoAudio,
      correction?: { type: 'melody' | 'rhythm'; classification: InputClassification },
    ) => {
      dispatch({ type: 'machine', event: 'PROCESS' });
      const controller = new AbortController();
      abortRef.current = controller;
      track('processing_started', { route: correction?.type ?? 'auto' });

      try {
        const result = await transcribe(audio, {
          mode: correction?.type === 'melody'
            ? 'voice'
            : correction?.type === 'rhythm'
              ? 'rhythm'
              : 'auto',
          signal: controller.signal,
          onProgress: (progress) => dispatch({ type: 'progress', progress }),
        });
        if (correction) {
          result.diagnostics.classification = correctClassification(
            correction.classification,
            correction.type,
          );
          result.diagnostics.warnings.push(`input_route_corrected:${correction.type}`);
        }
        dispatch({
          type: 'transcribed',
          notes: result.notes,
          phraseModel: result.phraseModel ?? null,
          judge: result.judge ?? null,
          referenceNotes: result.referenceNotes ?? [],
          drums: result.drums ?? [],
          diagnostics: result.diagnostics,
          melodyQuality: result.melodyQuality ?? null,
        });
        send('PROCESS_DONE');
        track('processing_completed', {
          transcriber: result.diagnostics.transcriberId,
          ms: Math.round(result.diagnostics.elapsedMs),
          notes: result.notes.length,
          inputType: result.diagnostics.classification?.type ?? 'legacy',
        });

        if (result.notes.length === 0 && (result.drums?.length ?? 0) === 0) {
          const code = result.melodyQuality && !result.melodyQuality.clear
            ? 'melody_unclear'
            : 'transcription_empty';
          fail(new AppError(code, 'rerecord', 'no events'));
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'transcription_cancelled') {
          send('CANCEL');
          return;
        }
        fail(error);
      } finally {
        abortRef.current = null;
      }
    },
    [send, fail],
  );

  const ingestAudioBlob = useCallback(
    async (
      blob: Blob,
      source: LocalSourceAsset,
      capturedEvent: Extract<CreationEvent, 'RECORDING_STOPPED' | 'AUDIO_IMPORTED'>,
    ) => {
      if (blob.size > MAX_AUDIO_UPLOAD_BYTES) {
        throw new AppError('file_too_large', 'retry', 'audio over 100 MiB');
      }
      const context = getAudioContext();
      const audio = await decodeToMono(blob, context);
      if (audio.durationSec > MAX_RECORDING_SEC + 0.25) {
        throw new AppError('audio_too_long', 'retry', `${audio.durationSec.toFixed(2)}s`);
      }
      const validation = validateAudio(audio);
      dispatch({ type: 'captured', audio, validation, source });
      send(capturedEvent);

      if (!validation.usable) {
        const code = validation.code === 'too_short' ? 'audio_too_short' : 'audio_silent';
        throw new AppError(
          code,
          capturedEvent === 'RECORDING_STOPPED' ? 'rerecord' : 'retry',
          validation.code,
        );
      }
      await runTranscription(audio);
      return audio;
    },
    [runTranscription, send],
  );

  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;

    try {
      const blob = await recorder.stop();
      if (captureRef.current) {
        closeMicrophone(captureRef.current);
        captureRef.current = null;
      }
      const audio = await ingestAudioBlob(
        blob,
        {
          kind: 'recording',
          filename: `original-recording.${extensionForMime(blob.type)}`,
          mimeType: blob.type || 'application/octet-stream',
          blob,
        },
        'RECORDING_STOPPED',
      );
      track('recording_completed', { seconds: Math.round(audio.durationSec), route: 'auto' });
    } catch (error) {
      stopEverything();
      fail(error);
    }
  }, [fail, stopEverything, ingestAudioBlob]);

  const uploadAudio = useCallback(
    async (file: File) => {
      dispatch({ type: 'clearError' });
      // A picker remains visible while the take is armed. Choosing a file must
      // release that microphone before file processing takes over.
      stopEverything();
      try {
        if (!isLikelyAudioFile(file)) {
          throw new AppError('unsupported_file', 'retry', file.type || file.name.slice(-12));
        }
        await unlockAudio();
        await ingestAudioBlob(
          file,
          {
            kind: 'audio-upload',
            filename: file.name || `uploaded-audio.${extensionForMime(file.type)}`,
            mimeType: file.type || 'application/octet-stream',
            blob: file,
          },
          'AUDIO_IMPORTED',
        );
      } catch (error) {
        const mapped =
          error instanceof AppError && error.code === 'decode_failed'
            ? new AppError('decode_failed', 'retry', error.detail, { cause: error })
            : error;
        fail(mapped);
      }
    },
    [ingestAudioBlob, fail, stopEverything],
  );

  const applyMidiImport = useCallback(
    (
      result: MidiImportResult,
      source: LocalSourceAsset,
      correction?: 'melody' | 'rhythm',
    ) => {
      const plan = planMidiImport(result, correction);
      const classification = correction
        ? correctClassification(plan.classification, correction)
        : plan.classification;
      const { mode, notes, drums } = plan;
      const phraseModel = mode === 'melody'
        ? buildMusicalPhraseModel(notes, {
            sourceKind:
              classification.type === 'polyphonic' || classification.type === 'mixed'
                ? 'polyphonic'
                : 'symbolic',
            interpretationNotes: plan.judge?.notes ?? notes,
          })
        : null;
      dispatch({
        type: 'midiImported',
        mode,
        bpm: result.bpm,
        meter: result.meter,
        notes,
        phraseModel,
        drums,
        durationSec: result.durationSec,
        source,
        diagnostics: {
          transcriberId: 'midi-import',
          backend: 'browser',
          elapsedMs: 0,
          modelLoadMs: 0,
          modelFromCache: true,
          notesBeforeFilter: result.notes.length + result.drums.length,
          notesAfterFilter: notes.length + drums.length,
          warnings: [
            ...(plan.pitchedNotesAsRhythm > 0
              ? [`midi_pitched_notes_as_rhythm:${plan.pitchedNotesAsRhythm}`]
              : []),
            `input_classified:${classification.type}:${classification.confidence.toFixed(3)}`,
            ...(correction ? [`input_route_corrected:${correction}`] : []),
          ],
          classification,
        },
        judge: plan.judge,
      });
      send('MIDI_IMPORTED');
    },
    [send],
  );

  const uploadMidi = useCallback(
    async (file: File) => {
      dispatch({ type: 'clearError' });
      stopEverything();
      try {
        if (file.size > MAX_MIDI_UPLOAD_BYTES) {
          throw new AppError('file_too_large', 'retry', 'MIDI over 5 MiB');
        }
        if (!/\.(?:mid|midi)$/i.test(file.name) && !/midi/i.test(file.type)) {
          throw new AppError('unsupported_file', 'retry', file.type || file.name.slice(-12));
        }
        const result = importMidi(new Uint8Array(await file.arrayBuffer()));
        if (result.durationSec > MAX_RECORDING_SEC + 0.25) {
          throw new AppError('audio_too_long', 'retry', `${result.durationSec.toFixed(2)}s MIDI`);
        }
        applyMidiImport(result, {
          kind: 'midi-upload',
          filename: file.name || 'source.mid',
          mimeType: file.type || 'audio/midi',
          blob: file,
        });
      } catch (error) {
        fail(error);
      }
    },
    [applyMidiImport, fail, stopEverything],
  );

  /**
   * Opens the microphone and starts recording, in that order and nothing else.
   *
   * There used to be a count-in between the two: one bar of metronome, with
   * recording scheduled on the audio clock so the user's first note would land
   * on a beat. It is gone with the rest of the tempo premise, and its removal
   * fixes something the click track was quietly doing to the evidence — on a
   * laptop without headphones the metronome is *in the recording*, four
   * periodic transients at the top of the take that the onset detector and the
   * tempo estimator then had to see.
   *
   * `ARM` and `RECORDING_STARTED` are still two events rather than one because
   * they mark two real moments: permission granted, and capture live.
   */
  const arm = useCallback(async () => {
    dispatch({ type: 'clearError' });
    try {
      await unlockAudio();
      const capture = await openMicrophone();
      captureRef.current = capture;
      send('ARM');

      const context = getAudioContext();
      recorderRef.current = startRecording(context, capture, {
        maxDurationSec: MAX_RECORDING_SEC,
        onLevel: (level) => dispatch({ type: 'level', level }),
        onDurationChange: (seconds) => dispatch({ type: 'elapsed', seconds }),
        onAutoStop: () => void finishRecording(),
      });
      send('RECORDING_STARTED');
      track('recording_started', { mode: state.mode });
    } catch (error) {
      stopEverything();
      fail(error);
    }
  }, [state.mode, send, fail, stopEverything, finishRecording]);

  const cancelRecording = useCallback(() => {
    stopEverything();
    send('CANCEL');
  }, [stopEverything, send]);

  const cancelProcessing = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reprocess = useCallback(() => {
    if (state.audio) void runTranscription(state.audio);
  }, [state.audio, runTranscription]);

  // --- Review, render, playback -----------------------------------------

  const setRetouch = useCallback(
    (amount: number) => {
      dispatch({ type: 'setRetouch', amount });
      if (state.machine.state === 'ready' || state.machine.state === 'published') {
        send('RETOUCH_CHANGED');
      }
    },
    [state.machine.state, send],
  );

  const setInstrument = useCallback(
    (id: string) => {
      dispatch({ type: 'setInstrument', id });
      track('instrument_selected', { instrument: id });
    },
    [],
  );

  const stopPlayback = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    dispatch({ type: 'playing', playing: false, origin: null });
  }, []);

  const correctInputRoute = useCallback(
    async (type: 'melody' | 'rhythm') => {
      const classification = state.diagnostics?.classification;
      const source = state.source;
      if (!classification || !source) return;

      dispatch({ type: 'clearError' });
      stopPlayback();
      track('input_route_corrected', { from: classification.type, to: type });
      try {
        if (source.kind === 'midi-upload') {
          const result = importMidi(new Uint8Array(await source.blob.arrayBuffer()));
          applyMidiImport(result, source, type);
          return;
        }
        if (!state.audio) return;
        dispatch({ type: 'rerouteAudio' });
        await runTranscription(state.audio, { type, classification });
      } catch (error) {
        fail(error);
      }
    },
    [
      state.diagnostics?.classification,
      state.source,
      state.audio,
      stopPlayback,
      applyMidiImport,
      runTranscription,
      fail,
    ],
  );

  const play = useCallback(async () => {
    if (!refined) return;
    stopPlayback();
    try {
      const context = await unlockAudio();
      const handle = await playSketch(context, {
        instrumentId: state.instrumentId,
        notes: refined.notes,
        drums: refined.drums,
        // The version's own length. Scheduling has always covered every note,
        // but the playhead is driven from this and would otherwise finish a
        // third of the way through an Expanded passage and sit at the end while
        // the music kept going.
        durationSec: musicalDuration,
        master: state.master,
      });
      playbackRef.current = handle;
      dispatch({ type: 'playing', playing: true, origin: handle.startedAtSec });
    } catch (error) {
      fail(error);
    }
  }, [refined, state.instrumentId, state.master, musicalDuration, stopPlayback, fail]);

  const render = useCallback(async () => {
    if (!refined || musicalDuration <= 0) return null;
    // Captured before the await, not after it. The ref moves when the screen
    // moves; stamping the *finished* key onto audio rendered from the material
    // as it was at the start would label a stale render as current, which is the
    // failure this key exists to catch.
    const keyAtStart = renderKeyRef.current;
    stopPlayback();
    send('RENDER');
    track('render_started', { instrument: state.instrumentId });
    try {
      const { encodeWav } = await import('@audio-core');
      const result = await renderSketch({
        instrumentId: state.instrumentId,
        notes: refined.notes,
        drums: refined.drums,
        // The whole selected version, however far past the recording it runs.
        durationSec: musicalDuration,
        master: state.master,
      });
      const channels: Float32Array[] = [];
      for (let channel = 0; channel < result.buffer.numberOfChannels; channel += 1) {
        channels.push(result.buffer.getChannelData(channel));
      }
      const wav = encodeWav(channels, { sampleRate: result.buffer.sampleRate });
      const blob = new Blob([wav], { type: 'audio/wav' });
      dispatch({
        type: 'rendered',
        blob,
        ratio: result.realtimeRatio,
        // Stamped with what it was rendered from. `renderKeyRef` rather than
        // `renderKey` because this callback awaits, and the key it closed over
        // could describe a screen the user has already moved on from.
        key: keyAtStart ?? '',
      });
      send('RENDER_DONE');
      track('render_completed', {
        instrument: state.instrumentId,
        ratio: Number(result.realtimeRatio.toFixed(3)),
      });
      return blob;
    } catch (error) {
      fail(error);
      return null;
    }
  }, [refined, musicalDuration, state.instrumentId, state.master, send, stopPlayback, fail]);

  // --- Persistence -------------------------------------------------------

  /**
   * US-0802 - autosave, debounced.
   *
   * Only from `review` onward. Saving a half-finished capture would put a
   * sketch in the workspace that cannot be opened, which the story explicitly
   * forbids ("incomplete/transient states are not persisted as corrupted final
   * data").
   */
  useEffect(() => {
    if (!['review', 'rendering', 'ready', 'publishing', 'published'].includes(state.machine.state)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveSketch({
        id: state.sketchId,
        title: state.title,
        locale,
        bpm: encodedBpm,
        freeTiming: performanceTempo.freeTiming,
        meter: state.meter,
        mode: state.mode,
        instrumentId: state.instrumentId,
        retouch: {
          amount: state.retouchAmount,
          grid: refined?.grid ?? 16,
          keyOverride: state.keyOverride
            ? { root: state.keyOverride.root as never, mode: state.keyOverride.mode }
            : undefined,
        },
        rawNotes: state.rawNotes,
        phraseModel: state.phraseModel ?? undefined,
        rawDrums: state.rawDrums,
        analysis: refined?.analysis ?? null,
        durationSec: state.durationSec,
        // The validated blob, not the raw one. Persisting a render that no
        // longer matches the sketch would put the mismatch beyond the reach of
        // the in-memory check and hand it to the next session as fact.
        renderedAudio: renderedAudio ?? undefined,
        source: state.source ?? undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        publishedId: state.publishedId ?? undefined,
        schemaVersion: LOCAL_SCHEMA_VERSION,
        // Musician output cannot be recomputed -- the same seed on a different
        // model revision is a different result -- so unlike every other version
        // it has to be stored rather than derived.
        //
        // Only while it belongs to *this* source. `useMusicianJob` empties its
        // own state when the source changes; this ref is a separate copy that
        // does not hear about that, and left unchecked it would pair one
        // source's notes with another source's generated versions in the saved
        // record -- the same contamination one layer down, and harder to see
        // because nothing about it is on screen. Compared here rather than
        // cleared on change: clearing leaves a render in which the stale value
        // is still readable, and the thing reading it is this debounced save.
        musician: toStoredMusician(
          musicianPersistRef.current?.sourceId === state.sourceId
            ? musicianPersistRef.current
            : null,
        ),
        selectedVersionId: state.versionId ?? undefined,
      })
        .then((result) => {
          if (result.audioDropped || result.sourceDropped) {
            dispatch({ type: 'storageWarning', low: true });
          }
        })
        .catch((error) => {
          // A save failure must be visible but must never interrupt creation.
          const appError = toAppError(error, 'storage_failed', 'retry');
          if (appError.code === 'storage_quota_exceeded') {
            dispatch({ type: 'storageWarning', low: true });
          }
        });
    }, 800);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.machine.state,
    state.sketchId,
    state.title,
    encodedBpm,
    performanceTempo,
    state.retouchAmount,
    state.instrumentId,
    state.rawNotes,
    state.phraseModel,
    state.referenceNotes,
    state.sourceId,
    renderedAudio,
    state.source,
    state.durationSec,
    state.publishedId,
    refined,
    locale,
  ]);

  /** Nothing is left running when the page goes away. */
  useEffect(
    () => () => {
      stopEverything();
      stopPlayback();
      abortRef.current?.abort();
    },
    [stopEverything, stopPlayback],
  );

  /**
   * The state as everything below this hook sees it.
   *
   * Identical to the reducer's, except that `renderedAudio` is the key-checked
   * value. Overridden here rather than at each call site so that no component
   * can read a render that no longer matches what is on screen by forgetting to
   * ask.
   */
  const publicState = useMemo<FlowState>(
    () => ({ ...state, renderedAudio }),
    [state, renderedAudio],
  );

  return {
    state: publicState,
    refined,
    /** What the performance itself said about tempo, meter and groove. */
    rhythm,
    /**
     * The tempo the music was performed at, or free timing when it had none.
     *
     * Read by everything that needs the music's tempo: the exported MIDI's
     * tempo map, the piano roll's bar lines, the published metadata. There is
     * no second tempo for it to be distinguished from any more — the only input
     * is the recording.
     */
    performanceTempo,
    /**
     * How long the selected version runs, in seconds.
     *
     * Distinct from `state.durationSec`, which is how long the recording is.
     * Playback, rendering, the piano roll and the published metadata all measure
     * the music; the Judge, the Teacher and the Identity Guard all measure the
     * recording. Collapsing the two truncated Expanded to the length of the hum
     * it grew from.
     */
    musicalDurationSec: musicalDuration,
    /** The versions on offer; the original performance is always one of them. */
    versions,
    activeVersion,
    /**
     * Notes for every version that has them, for the export package.
     *
     * Built from the same resolver the player uses, so a MIDI file in the zip
     * is the same music the user heard rather than a second derivation that
     * could drift from it.
     */
    versionNotes,
    versionProvenance,
    /**
     * The Musician, and the request that would be sent for it.
     *
     * `requestMusician` builds the payload at call time from the Teacher's
     * current notes rather than closing over them, so a user who adjusts
     * cleanup and *then* presses generate gets what they are looking at.
     */
    musician: {
      ...musician,
      available: musicianAvailability.available,
      /**
       * Why a generated version is not in the picker.
       *
       * Withholding without saying so is its own failure: the user pressed a
       * button, waited, and then found nothing new, with no way to tell a model
       * that had nothing to add from an app that lost the result.
       */
      withheld: musicianWithheld,
      generate: () => {
        const request = buildMusicianRequest();
        if (request) musician.generate(request);
      },
      regenerate: () => {
        const request = buildMusicianRequest();
        if (request) musician.regenerate(request);
      },
    },
    /** What a teacher would suggest, and why. Null outside the pitched path. */
    lesson,
    actions: {
      arm,
      uploadAudio,
      uploadMidi,
      stopRecording: finishRecording,
      cancelRecording,
      cancelProcessing,
      reprocess,
      correctInputRoute,
      setRetouch,
      setVersion: (versionId: VersionId) => dispatch({ type: 'setVersion', versionId }),
      setKey: (key: FlowState['keyOverride']) => dispatch({ type: 'setKey', key }),
      setInstrument,
      setMaster: (master: Partial<MasterSettings>) => dispatch({ type: 'setMaster', master }),
      setTitle: (title: string) => dispatch({ type: 'setTitle', title }),
      play,
      stopPlayback,
      render,
      rerecord: () => {
        stopPlayback();
        send('RERECORD');
      },
      clearError: () => dispatch({ type: 'clearError' }),
      retry: () => {
        dispatch({ type: 'clearError' });
        dispatch({ type: 'machine', event: 'RETRY' });
      },
      reset: () => {
        stopEverything();
        stopPlayback();
        dispatch({ type: 'reset', id: newSketchId() });
      },
      published: (id: string, shareUrl: string, manageToken: string) => {
        dispatch({ type: 'published', id, shareUrl, manageToken });
        send('PUBLISH_DONE');
      },
      startPublish: () => send('PUBLISH'),
      unpublished: () => {
        dispatch({ type: 'unpublished' });
        send('UNPUBLISH');
      },
      fail,
    },
  };
}

export type CreationFlow = ReturnType<typeof useCreationFlow>;

function extensionForMime(mimeType: string): string {
  const value = mimeType.toLowerCase();
  if (value.includes('wav')) return 'wav';
  if (value.includes('mpeg')) return 'mp3';
  if (value.includes('mp4') || value.includes('aac')) return 'm4a';
  if (value.includes('ogg')) return 'ogg';
  return 'webm';
}

function isLikelyAudioFile(file: File): boolean {
  if (file.type.toLowerCase().startsWith('audio/')) return true;
  return /\.(?:wav|mp3|m4a|aac|ogg|oga|webm|flac|mp4)$/i.test(file.name);
}
