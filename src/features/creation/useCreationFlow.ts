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
  toAppError,
  type AudioValidation,
  type CreationMode,
  type Locale,
  type Meter,
  type MonoAudio,
  type NoteEvent,
  type ProcessingDiagnostics,
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
/** PRD R-04: one measure. */
export const COUNT_IN_BARS = 1;

export interface FlowState {
  machine: MachineContext;
  sketchId: string;
  title: string;
  mode: CreationMode;
  bpm: number | null;
  meter: Meter;
  metronomeMuted: boolean;
  tapHistory: number[];
  tapCount: number;

  beat: BeatInfo | null;
  level: LevelSnapshot | null;
  elapsedSec: number;

  audio: MonoAudio | null;
  validation: AudioValidation | null;

  rawNotes: NoteEvent[];
  rawDrums: RefineResult['drums'];
  diagnostics: ProcessingDiagnostics | null;
  progress: TranscriptionProgress | null;

  retouchAmount: number;
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
  | { type: 'setBpm'; bpm: number }
  | { type: 'setMeter'; meter: Meter }
  | { type: 'tap'; history: number[]; bpm: number | null; tapCount: number }
  | { type: 'toggleMetronome' }
  | { type: 'beat'; beat: BeatInfo }
  | { type: 'level'; level: LevelSnapshot }
  | { type: 'elapsed'; seconds: number }
  | { type: 'captured'; audio: MonoAudio; validation: AudioValidation }
  | { type: 'progress'; progress: TranscriptionProgress }
  | {
      type: 'transcribed';
      notes: NoteEvent[];
      drums: RefineResult['drums'];
      diagnostics: ProcessingDiagnostics;
    }
  | { type: 'setRetouch'; amount: number }
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
    bpm: null,
    meter: DEFAULT_METER,
    metronomeMuted: false,
    tapHistory: [],
    tapCount: 0,
    beat: null,
    level: null,
    elapsedSec: 0,
    audio: null,
    validation: null,
    rawNotes: [],
    rawDrums: [],
    diagnostics: null,
    progress: null,
    retouchAmount: RETOUCH_AMOUNT_DEFAULT,
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
        rawDrums: [],
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
      return { ...state, audio: action.audio, validation: action.validation, level: null };
    case 'progress':
      return { ...state, progress: action.progress };
    case 'transcribed':
      return {
        ...state,
        rawNotes: action.notes,
        rawDrums: action.drums,
        diagnostics: action.diagnostics,
        progress: null,
        // A new transcription invalidates any previous render.
        renderedAudio: null,
        renderRealtimeRatio: null,
      };
    case 'setRetouch':
      return { ...state, retouchAmount: action.amount, renderedAudio: null };
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

  /** The refined result. Pure and cheap, so it is derived rather than stored. */
  const refined = useMemo<RefineResult | null>(() => {
    if (state.bpm === null) return null;
    if (state.rawNotes.length === 0 && state.rawDrums.length === 0) return null;
    const instrument = resolveInstrument(state.instrumentId, state.mode);
    try {
      return refine(
        { notes: state.rawNotes, drums: state.rawDrums },
        {
          bpm: state.bpm,
          mode: state.mode,
          amount: state.retouchAmount,
          keyOverride: state.keyOverride
            ? {
                root: state.keyOverride.root as never,
                mode: state.keyOverride.mode,
              }
            : undefined,
          playableRange: state.mode === 'melody' ? instrument.range : undefined,
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
    state.rawDrums,
    state.mode,
    state.retouchAmount,
    state.keyOverride,
    state.instrumentId,
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
          mode: state.mode,
          signal: controller.signal,
          onProgress: (progress) => dispatch({ type: 'progress', progress }),
        });
        dispatch({
          type: 'transcribed',
          notes: result.notes,
          drums: result.drums ?? [],
          diagnostics: result.diagnostics,
        });
        send('PROCESS_DONE');
        track('processing_completed', {
          transcriber: result.diagnostics.transcriberId,
          ms: Math.round(result.diagnostics.elapsedMs),
          notes: result.notes.length,
        });

        if (result.notes.length === 0 && (result.drums?.length ?? 0) === 0) {
          fail(new AppError('transcription_empty', 'rerecord', 'no events'));
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
    [state.mode, send, fail],
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
      const context = getAudioContext();
      const audio = await decodeToMono(blob, context);
      const validation = validateAudio(audio);
      dispatch({ type: 'captured', audio, validation });
      send('RECORDING_STOPPED');
      track('recording_completed', { seconds: Math.round(audio.durationSec), mode: state.mode });

      if (!validation.usable) {
        const code = validation.code === 'too_short' ? 'audio_too_short' : 'audio_silent';
        fail(new AppError(code, 'rerecord', validation.code));
        return;
      }
      await runTranscription(audio);
    } catch (error) {
      stopEverything();
      fail(error);
    }
  }, [send, fail, state.mode, stopEverything, runTranscription]);

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
        durationSec: state.audio?.durationSec ?? 0,
        master: state.master,
      });
      playbackRef.current = handle;
      dispatch({ type: 'playing', playing: true, origin: handle.startedAtSec });
    } catch (error) {
      fail(error);
    }
  }, [refined, state.instrumentId, state.master, state.audio, stopPlayback, fail]);

  const render = useCallback(async () => {
    if (!refined || state.audio === null) return;
    stopPlayback();
    send('RENDER');
    track('render_started', { instrument: state.instrumentId });
    try {
      const { encodeWav } = await import('@audio-core');
      const result = await renderSketch({
        instrumentId: state.instrumentId,
        notes: refined.notes,
        drums: refined.drums,
        durationSec: state.audio.durationSec,
        master: state.master,
      });
      const channels: Float32Array[] = [];
      for (let channel = 0; channel < result.buffer.numberOfChannels; channel += 1) {
        channels.push(result.buffer.getChannelData(channel));
      }
      const wav = encodeWav(channels, { sampleRate: result.buffer.sampleRate });
      dispatch({
        type: 'rendered',
        blob: new Blob([wav], { type: 'audio/wav' }),
        ratio: result.realtimeRatio,
      });
      send('RENDER_DONE');
      track('render_completed', {
        instrument: state.instrumentId,
        ratio: Number(result.realtimeRatio.toFixed(3)),
      });
    } catch (error) {
      fail(error);
    }
  }, [refined, state.audio, state.instrumentId, state.master, send, stopPlayback, fail]);

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
        durationSec: state.audio?.durationSec ?? 0,
        renderedAudio: state.renderedAudio ?? undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        publishedId: state.publishedId ?? undefined,
        schemaVersion: 1,
      })
        .then((result) => {
          if (result.audioDropped) dispatch({ type: 'storageWarning', low: true });
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
    state.renderedAudio,
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
    actions: {
      tap,
      setBpm,
      setMode,
      setMeter,
      toggleMetronome,
      arm,
      stopRecording: finishRecording,
      cancelRecording,
      cancelProcessing,
      reprocess,
      setRetouch,
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
