'use client';

/**
 * The creation flow's state.
 *
 * One reducer, one machine, one place where the audio side effects are ordered.
 * Components below this read a snapshot and call actions; none of them own
 * audio state, which is what stops the "unrelated booleans" failure mode the
 * playbook warns about.
 *
 * Effects that are genuinely imperative - opening the microphone, scheduling
 * the metronome, running the worker, rendering offline - live in refs rather
 * than state, because they are resources with lifetimes rather than values.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  AppError,
  DEFAULT_METER,
  LOCAL_SCHEMA_VERSION,
  toAppError,
  type AudioValidation,
  type CreationMode,
  type Locale,
  type LocalSourceAsset,
  type JudgeVerdict,
  type MelodyConfidence,
  type Meter,
  type MonoAudio,
  type NoteEvent,
  type ProcessingDiagnostics,
  type TranscriptionInputMode,
  type TranscriptionProgress,
} from '@contracts';
import {
  closeMicrophone,
  decodeToMono,
  getAudioContext,
  openMicrophone,
  startMetronome,
  startRecording,
  tapTempo,
  unlockAudio,
  validateAudio,
  type ActiveRecording,
  type BeatInfo,
  type CaptureStream,
  type LevelSnapshot,
  type MetronomeHandle,
} from '@audio-core';
import { refine, RETOUCH_AMOUNT_DEFAULT, type RefineResult } from '@retouch';
import {
  analyzeDrumRhythm,
  analyzeMelodyRhythm,
  compareTempos,
  defaultVersion,
  planVersions,
  type PerformanceRhythm,
  type TempoDisagreement,
  type VersionId,
  type VersionRecipe,
} from '@rhythm-extraction';
import { importMidi } from '@midi';
import {
  DEFAULT_MASTER,
  playSketch,
  renderSketch,
  resolveInstrument,
  type MasterSettings,
  type PlaybackHandle,
} from '@synthesis';
import { transcribe } from '@/features/transcription/client';
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
/** PRD R-04: one measure. */
export const COUNT_IN_BARS = 1;
export type MelodyInputMode = Exclude<TranscriptionInputMode, 'rhythm'>;

export interface FlowState {
  machine: MachineContext;
  sketchId: string;
  title: string;
  mode: CreationMode;
  melodyInputMode: MelodyInputMode;
  bpm: number | null;
  meter: Meter;
  metronomeMuted: boolean;
  tapHistory: number[];
  tapCount: number;

  beat: BeatInfo | null;
  level: LevelSnapshot | null;
  elapsedSec: number;

  audio: MonoAudio | null;
  /** Exact source bytes, retained locally for export and never published. */
  source: LocalSourceAsset | null;
  durationSec: number;
  validation: AudioValidation | null;

  rawNotes: NoteEvent[];
  /** The Judge's repair of `rawNotes`, and its verdict. Null outside the voice path. */
  judge: JudgeVerdict | null;
  referenceNotes: NoteEvent[];
  rawDrums: RefineResult['drums'];
  diagnostics: ProcessingDiagnostics | null;
  melodyQuality: MelodyConfidence | null;
  progress: TranscriptionProgress | null;

  retouchAmount: number;
  /** Which performance version the user is listening to; null means the default. */
  versionId: VersionId | null;
  keyOverride: { root: string; mode: 'major' | 'minor' } | null;

  instrumentId: string;
  master: MasterSettings;

  renderedAudio: Blob | null;
  renderRealtimeRatio: number | null;
  playing: boolean;
  playheadOrigin: number | null;

  publishedId: string | null;
  shareUrl: string | null;
  manageToken: string | null;

  error: { code: AppError['code']; recovery: AppError['recovery'] } | null;
  storageWarning: boolean;
}

type Action =
  | { type: 'machine'; event: CreationEvent; payload?: { code: AppError['code']; recovery: AppError['recovery'] } }
  | { type: 'setMode'; mode: CreationMode }
  | { type: 'setMelodyInputMode'; mode: MelodyInputMode }
  | { type: 'setBpm'; bpm: number }
  | { type: 'setMeter'; meter: Meter }
  | { type: 'tap'; history: number[]; bpm: number | null; tapCount: number }
  | { type: 'toggleMetronome' }
  | { type: 'beat'; beat: BeatInfo }
  | { type: 'level'; level: LevelSnapshot }
  | { type: 'elapsed'; seconds: number }
  | {
      type: 'captured';
      audio: MonoAudio;
      validation: AudioValidation;
      source: LocalSourceAsset;
    }
  | { type: 'progress'; progress: TranscriptionProgress }
  | {
      type: 'transcribed';
      judge: JudgeVerdict | null;
      notes: NoteEvent[];
      drums: RefineResult['drums'];
      diagnostics: ProcessingDiagnostics;
      referenceNotes: NoteEvent[];
      melodyQuality: MelodyConfidence | null;
    }
  | {
      type: 'midiImported';
      mode: CreationMode;
      bpm: number;
      meter: Meter;
      notes: NoteEvent[];
      drums: RefineResult['drums'];
      durationSec: number;
      source: LocalSourceAsset;
      diagnostics: ProcessingDiagnostics;
    }
  | { type: 'setRetouch'; amount: number }
  | { type: 'setVersion'; versionId: VersionId }
  | { type: 'setKey'; key: FlowState['keyOverride'] }
  | { type: 'setInstrument'; id: string }
  | { type: 'setMaster'; master: Partial<MasterSettings> }
  | { type: 'setTitle'; title: string }
  | { type: 'rendered'; blob: Blob; ratio: number }
  | { type: 'playing'; playing: boolean; origin: number | null }
  | { type: 'published'; id: string; shareUrl: string; manageToken: string }
  | { type: 'unpublished' }
  | { type: 'error'; error: AppError }
  | { type: 'clearError' }
  | { type: 'storageWarning'; low: boolean }
  | { type: 'reset'; id: string };

function initialState(sketchId: string, mode: CreationMode = 'melody'): FlowState {
  return {
    machine: INITIAL_CONTEXT,
    sketchId,
    title: '',
    mode,
    melodyInputMode: 'voice',
    bpm: null,
    meter: DEFAULT_METER,
    metronomeMuted: false,
    tapHistory: [],
    tapCount: 0,
    beat: null,
    level: null,
    elapsedSec: 0,
    audio: null,
    source: null,
    durationSec: 0,
    validation: null,
    rawNotes: [],
    judge: null,
    referenceNotes: [],
    rawDrums: [],
    diagnostics: null,
    melodyQuality: null,
    progress: null,
    retouchAmount: RETOUCH_AMOUNT_DEFAULT,
    versionId: null,
    keyOverride: null,
    instrumentId: resolveInstrument(undefined, mode).id,
    master: DEFAULT_MASTER,
    renderedAudio: null,
    renderRealtimeRatio: null,
    playing: false,
    playheadOrigin: null,
    publishedId: null,
    shareUrl: null,
    manageToken: null,
    error: null,
    storageWarning: false,
  };
}

function reducer(state: FlowState, action: Action): FlowState {
  switch (action.type) {
    case 'machine': {
      const result = transition(state.machine, action.event, action.payload);
      if (!result.accepted) return state;
      return { ...state, machine: result.context };
    }
    case 'setMode':
      return {
        ...state,
        mode: action.mode,
        // Instruments are mode-specific; carrying a piano into rhythm mode
        // would leave the gallery showing a selection that cannot be voiced.
        instrumentId: resolveInstrument(undefined, action.mode).id,
        rawNotes: [],
        referenceNotes: [],
        rawDrums: [],
        melodyQuality: null,
        audio: null,
        source: null,
        durationSec: 0,
        renderedAudio: null,
      };
    case 'setMelodyInputMode':
      return {
        ...state,
        melodyInputMode: action.mode,
        rawNotes: [],
        referenceNotes: [],
        rawDrums: [],
        audio: null,
        source: null,
        durationSec: 0,
        diagnostics: null,
        melodyQuality: null,
        renderedAudio: null,
      };
    case 'setBpm':
      return { ...state, bpm: action.bpm };
    case 'setMeter':
      return { ...state, meter: action.meter };
    case 'tap':
      return {
        ...state,
        tapHistory: action.history,
        tapCount: action.tapCount,
        bpm: action.bpm ?? state.bpm,
      };
    case 'toggleMetronome':
      return { ...state, metronomeMuted: !state.metronomeMuted };
    case 'beat':
      return { ...state, beat: action.beat };
    case 'level':
      return { ...state, level: action.level };
    case 'elapsed':
      return { ...state, elapsedSec: action.seconds };
    case 'captured':
      return {
        ...state,
        audio: action.audio,
        source: action.source,
        durationSec: action.audio.durationSec,
        validation: action.validation,
        level: null,
      };
    case 'progress':
      return { ...state, progress: action.progress };
    case 'transcribed':
      return {
        ...state,
        rawNotes: action.notes,
        judge: action.judge,
        referenceNotes: action.referenceNotes,
        rawDrums: action.drums,
        diagnostics: action.diagnostics,
        melodyQuality: action.melodyQuality,
        progress: null,
        // A new take has its own tempo and groove, so the previous choice of
        // version described a performance that no longer exists.
        versionId: null,
        // A new transcription invalidates any previous render.
        renderedAudio: null,
        renderRealtimeRatio: null,
      };
    case 'midiImported':
      return {
        ...state,
        mode: action.mode,
        bpm: action.bpm,
        meter: action.meter,
        instrumentId: resolveInstrument(undefined, action.mode).id,
        audio: null,
        source: action.source,
        durationSec: action.durationSec,
        validation: null,
        rawNotes: action.notes,
        referenceNotes: [],
        rawDrums: action.drums,
        diagnostics: action.diagnostics,
        melodyQuality: null,
        progress: null,
        renderedAudio: null,
        renderRealtimeRatio: null,
      };
    case 'setRetouch':
      return { ...state, retouchAmount: action.amount, renderedAudio: null };
    case 'setVersion':
      return { ...state, versionId: action.versionId, renderedAudio: null };
    case 'setKey':
      return { ...state, keyOverride: action.key, renderedAudio: null };
    case 'setInstrument':
      return { ...state, instrumentId: action.id, renderedAudio: null };
    case 'setMaster':
      return { ...state, master: { ...state.master, ...action.master }, renderedAudio: null };
    case 'setTitle':
      return { ...state, title: action.title };
    case 'rendered':
      return { ...state, renderedAudio: action.blob, renderRealtimeRatio: action.ratio };
    case 'playing':
      return { ...state, playing: action.playing, playheadOrigin: action.origin };
    case 'published':
      return {
        ...state,
        publishedId: action.id,
        shareUrl: action.shareUrl,
        manageToken: action.manageToken,
      };
    case 'unpublished':
      return { ...state, publishedId: null, shareUrl: null, manageToken: null };
    case 'error':
      return { ...state, error: { code: action.error.code, recovery: action.error.recovery } };
    case 'clearError':
      return { ...state, error: null };
    case 'storageWarning':
      return { ...state, storageWarning: action.low };
    case 'reset':
      return initialState(action.id, state.mode);
  }
}

export function useCreationFlow(locale: Locale) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(newSketchId()));
  const sourceKind = state.source?.kind;

  const captureRef = useRef<CaptureStream | null>(null);
  const recorderRef = useRef<ActiveRecording | null>(null);
  const metronomeRef = useRef<MetronomeHandle | null>(null);
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
   * Derived from the take, not from the metronome. Recomputed only when the
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

  /** The versions on offer. The original performance is always one of them. */
  const versions = useMemo<VersionRecipe[]>(() => {
    if (rhythm === null || state.bpm === null) return [];
    return planVersions({
      rhythm,
      tappedBpm: state.bpm,
      mode: state.mode,
      amount: state.retouchAmount,
    });
  }, [rhythm, state.bpm, state.mode, state.retouchAmount]);

  /** The version in effect: the user's choice, or the honest default. */
  const activeVersion = useMemo<VersionRecipe | null>(() => {
    if (versions.length === 0) return null;
    const wanted = state.versionId ?? (rhythm ? defaultVersion(rhythm) : 'grid');
    return versions.find((version) => version.id === wanted) ?? versions[0] ?? null;
  }, [versions, state.versionId, rhythm]);

  /**
   * Whether the tapped tempo and the heard tempo disagree, and how.
   * Surfaced rather than silently resolved: a half-or-double gap usually means
   * the user tapped eighths while singing quarters, and saying so is more
   * useful than picking one for them.
   */
  const tempoDisagreement = useMemo<TempoDisagreement | null>(
    () => (rhythm && state.bpm !== null ? compareTempos(rhythm, state.bpm) : null),
    [rhythm, state.bpm],
  );

  /** The refined result. Pure and cheap, so it is derived rather than stored. */
  const refined = useMemo<RefineResult | null>(() => {
    if (state.bpm === null) return null;
    if (state.rawNotes.length === 0 && state.rawDrums.length === 0) return null;
    const instrument = resolveInstrument(state.instrumentId, state.mode);
    try {
      // Which notes a version is built from is part of what the version *is*.
      // Unprocessed shows the candidate exactly as it arrived; the Judge and
      // the Teacher both build on the repaired reading, because tidying notes
      // that still contain a harmonic artifact only produces a tidy mistake.
      const sourceNotes =
        activeVersion !== null && activeVersion.id !== 'unprocessed' && state.judge !== null
          ? state.judge.notes
          : state.rawNotes;

      return refine(
        { notes: sourceNotes, drums: state.rawDrums },
        {
          // The version decides the tempo, which may be the one that was heard
          // rather than the one that was tapped.
          bpm: activeVersion?.bpm ?? state.bpm,
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
        },
      );
    } catch {
      // Retouch is pure; a throw here means malformed input, not a transient
      // failure. Returning null shows the empty-result state instead of a crash.
      return null;
    }
  }, [
    state.bpm,
    state.rawNotes,
    state.referenceNotes,
    state.rawDrums,
    state.mode,
    state.retouchAmount,
    state.keyOverride,
    state.instrumentId,
    sourceKind,
    activeVersion,
    state.judge,
  ]);

  // --- Tempo -------------------------------------------------------------

  const tap = useCallback(() => {
    const context = getAudioContext();
    const { history, result } = tapTempo(state.tapHistory, context.currentTime);
    dispatch({ type: 'tap', history, bpm: result.bpm, tapCount: result.tapCount });
    if (result.bpm !== null) {
      send('TEMPO_SET');
      track('tempo_set', { method: 'tap', bpm: result.bpm });
    }
  }, [state.tapHistory, send]);

  const setBpm = useCallback(
    (bpm: number) => {
      dispatch({ type: 'setBpm', bpm });
      send('TEMPO_SET');
      track('tempo_set', { method: 'slider', bpm });
    },
    [send],
  );

  const setMode = useCallback(
    (mode: CreationMode) => {
      dispatch({ type: 'setMode', mode });
      send('MODE_CHANGED');
      track('mode_selected', { mode });
    },
    [send],
  );

  const setMelodyInputMode = useCallback(
    (mode: MelodyInputMode) => {
      dispatch({ type: 'setMelodyInputMode', mode });
      send('MODE_CHANGED');
      track('melody_input_mode_selected', { mode });
    },
    [send],
  );

  const setMeter = useCallback((meter: Meter) => dispatch({ type: 'setMeter', meter }), []);
  const toggleMetronome = useCallback(() => dispatch({ type: 'toggleMetronome' }), []);

  // --- Recording ---------------------------------------------------------

  const stopEverything = useCallback(() => {
    if (startTimerRef.current !== null) {
      clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
    metronomeRef.current?.stop();
    metronomeRef.current = null;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    if (captureRef.current) {
      closeMicrophone(captureRef.current);
      captureRef.current = null;
    }
  }, []);

  // --- Transcription -----------------------------------------------------

  const runTranscription = useCallback(
    async (audio: MonoAudio) => {
      dispatch({ type: 'machine', event: 'PROCESS' });
      const controller = new AbortController();
      abortRef.current = controller;
      track('processing_started', { mode: state.mode });

      try {
        const result = await transcribe(audio, {
          mode: state.mode === 'rhythm' ? 'rhythm' : state.melodyInputMode,
          signal: controller.signal,
          onProgress: (progress) => dispatch({ type: 'progress', progress }),
        });
        dispatch({
          type: 'transcribed',
          notes: result.notes,
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
    [state.mode, state.melodyInputMode, send, fail],
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
    metronomeRef.current?.stop();
    metronomeRef.current = null;

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
      track('recording_completed', { seconds: Math.round(audio.durationSec), mode: state.mode });
    } catch (error) {
      stopEverything();
      fail(error);
    }
  }, [fail, state.mode, stopEverything, ingestAudioBlob]);

  const uploadAudio = useCallback(
    async (file: File) => {
      if (state.bpm === null) return;
      dispatch({ type: 'clearError' });
      // A picker remains visible while the take is armed. Choosing a file must
      // release that microphone/count-in before file processing takes over.
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
    [state.bpm, ingestAudioBlob, fail, stopEverything],
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
        const mode: CreationMode =
          state.mode === 'melody' && result.notes.length === 0
            ? 'rhythm'
            : state.mode === 'rhythm' && result.drums.length === 0
              ? 'melody'
              : state.mode;
        dispatch({
          type: 'midiImported',
          mode,
          bpm: result.bpm,
          meter: result.meter,
          notes: result.notes,
          drums: result.drums,
          durationSec: result.durationSec,
          source: {
            kind: 'midi-upload',
            filename: file.name || 'source.mid',
            mimeType: file.type || 'audio/midi',
            blob: file,
          },
          diagnostics: {
            transcriberId: 'midi-import',
            backend: 'browser',
            elapsedMs: 0,
            modelLoadMs: 0,
            modelFromCache: true,
            notesBeforeFilter: result.notes.length + result.drums.length,
            notesAfterFilter: result.notes.length + result.drums.length,
            warnings: [],
          },
        });
        send('MIDI_IMPORTED');
      } catch (error) {
        fail(error);
      }
    },
    [state.mode, send, fail, stopEverything],
  );

  const arm = useCallback(async () => {
    if (state.bpm === null) return;
    dispatch({ type: 'clearError' });
    try {
      await unlockAudio();
      const capture = await openMicrophone();
      captureRef.current = capture;
      send('ARM');

      const context = getAudioContext();
      const metronome = startMetronome(
        context,
        context.destination,
        {
          bpm: state.bpm,
          beatsPerBar: state.meter.beatsPerBar,
          countInBars: COUNT_IN_BARS,
          muted: state.metronomeMuted,
        },
        (beat) => dispatch({ type: 'beat', beat }),
      );
      metronomeRef.current = metronome;
      send('COUNT_IN_STARTED');

      // Recording starts on the audio clock, not on a UI timer: the count-in
      // has to end exactly on the beat the user is about to sing on.
      const delayMs = Math.max(0, (metronome.startTimeSec - context.currentTime) * 1000);
      startTimerRef.current = window.setTimeout(() => {
        startTimerRef.current = null;
        if (!captureRef.current) return;
        recorderRef.current = startRecording(context, captureRef.current, {
          maxDurationSec: MAX_RECORDING_SEC,
          onLevel: (level) => dispatch({ type: 'level', level }),
          onDurationChange: (seconds) => dispatch({ type: 'elapsed', seconds }),
          onAutoStop: () => void finishRecording(),
        });
        send('RECORDING_STARTED');
        track('recording_started', { mode: state.mode, bpm: state.bpm ?? 0 });
      }, delayMs);
    } catch (error) {
      stopEverything();
      fail(error);
    }
  }, [
    state.bpm,
    state.meter.beatsPerBar,
    state.metronomeMuted,
    state.mode,
    send,
    fail,
    stopEverything,
    finishRecording,
  ]);

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

  const play = useCallback(async () => {
    if (!refined) return;
    stopPlayback();
    try {
      const context = await unlockAudio();
      const handle = await playSketch(context, {
        instrumentId: state.instrumentId,
        notes: refined.notes,
        drums: refined.drums,
        durationSec: state.durationSec,
        master: state.master,
      });
      playbackRef.current = handle;
      dispatch({ type: 'playing', playing: true, origin: handle.startedAtSec });
    } catch (error) {
      fail(error);
    }
  }, [refined, state.instrumentId, state.master, state.durationSec, stopPlayback, fail]);

  const render = useCallback(async () => {
    if (!refined || state.durationSec <= 0) return null;
    stopPlayback();
    send('RENDER');
    track('render_started', { instrument: state.instrumentId });
    try {
      const { encodeWav } = await import('@audio-core');
      const result = await renderSketch({
        instrumentId: state.instrumentId,
        notes: refined.notes,
        drums: refined.drums,
        durationSec: state.durationSec,
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
  }, [refined, state.durationSec, state.instrumentId, state.master, send, stopPlayback, fail]);

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
    if (state.bpm === null) return;
    if (!['review', 'rendering', 'ready', 'publishing', 'published'].includes(state.machine.state)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveSketch({
        id: state.sketchId,
        title: state.title,
        locale,
        bpm: state.bpm as number,
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
        rawDrums: state.rawDrums,
        analysis: refined?.analysis ?? null,
        durationSec: state.durationSec,
        renderedAudio: state.renderedAudio ?? undefined,
        source: state.source ?? undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        publishedId: state.publishedId ?? undefined,
        schemaVersion: LOCAL_SCHEMA_VERSION,
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
    state.bpm,
    state.retouchAmount,
    state.instrumentId,
    state.rawNotes,
    state.referenceNotes,
    state.renderedAudio,
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

  return {
    state,
    refined,
    /** What the performance itself said about tempo, meter and groove. */
    rhythm,
    /** The versions on offer; the original performance is always one of them. */
    versions,
    activeVersion,
    /** Set when the heard tempo and the tapped tempo disagree. */
    tempoDisagreement,
    actions: {
      tap,
      setBpm,
      setMode,
      setMelodyInputMode,
      setMeter,
      toggleMetronome,
      arm,
      uploadAudio,
      uploadMidi,
      stopRecording: finishRecording,
      cancelRecording,
      cancelProcessing,
      reprocess,
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
