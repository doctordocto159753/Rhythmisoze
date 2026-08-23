/**
 * The creation flow's state, as a pure reducer.
 *
 * Lifted out of the hook so that the one invariant this module exists to hold —
 * *a new source invalidates everything derived from the old one* — can be
 * checked directly, without a React tree and without audio hardware. It was
 * previously a private function inside a fifteen-hundred-line client component,
 * which is why the invariant was never tested and why it was broken.
 *
 * Nothing here imports React, the DOM or the audio engine. It is values in,
 * values out.
 */

import {
  AppError,
  DEFAULT_METER,
  type AudioValidation,
  type CreationMode,
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
import type { BeatInfo, LevelSnapshot } from '@audio-core';
import { RETOUCH_AMOUNT_DEFAULT, type RefineResult } from '@retouch';
import type { TempoChoice, VersionId } from '@rhythm-extraction';
import { DEFAULT_MASTER, resolveInstrument, type MasterSettings } from '@synthesis';
import {
  INITIAL_CONTEXT,
  transition,
  type CreationEvent,
  type MachineContext,
} from '@/features/state/machine';

export type MelodyInputMode = Exclude<TranscriptionInputMode, 'auto' | 'rhythm'>;

export interface FlowState {
  machine: MachineContext;
  /** Identity of the saved sketch. Stable across takes; the workspace key. */
  sketchId: string;
  /**
   * Identity of the *evidence* currently loaded — this recording, this file.
   *
   * Distinct from `sketchId` because they answer different questions. The sketch
   * is the piece of work and survives re-recording; the source is the material
   * being interpreted, and changes every time the user records again or imports
   * a file. Anything derived from the audio or the MIDI keys to this, so a
   * result computed for one source cannot present itself as belonging to
   * another.
   */
  sourceId: string;
  /** How many sources this sketch has had. Only `sourceId` is built from it. */
  sourceSerial: number;
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
  /**
   * How long the *recording* is.
   *
   * Source evidence, and only that. It is what the Judge, the Teacher and the
   * Identity Guard measure the performance against, and it must keep meaning
   * that even when the version being listened to is four times longer. What is
   * played back and rendered is `musicalDurationSec`, derived from the notes.
   */
  durationSec: number;
  validation: AudioValidation | null;

  rawNotes: NoteEvent[];
  /** The current source's Judge verdict. Null for rhythm-only material. */
  judge: JudgeVerdict | null;
  referenceNotes: NoteEvent[];
  rawDrums: RefineResult['drums'];
  diagnostics: ProcessingDiagnostics | null;
  melodyQuality: MelodyConfidence | null;
  progress: TranscriptionProgress | null;

  retouchAmount: number;
  /** Which performance version the user is listening to; null means the default. */
  versionId: VersionId | null;
  /**
   * Which tempo the user has asked the musical versions to be built on.
   *
   * `'performance'` unless they explicitly asked for the metronome value. It is
   * never set by the app: a confidence score is not a user decision, and letting
   * one act like one is the whole of the bug this field exists to close.
   */
  tempoChoice: TempoChoice;
  keyOverride: { root: string; mode: 'major' | 'minor' } | null;

  instrumentId: string;
  master: MasterSettings;

  renderedAudio: Blob | null;
  /**
   * What `renderedAudio` is a render *of*.
   *
   * The reducer nulls `renderedAudio` on every input it knows about — version,
   * instrument, cleanup, key, master, a new transcription — and that list is a
   * list of things somebody remembered. It did not include a Musician result
   * arriving: press "Try another", keep the new set, and the notes under
   * `musician-refined` change while the WAV rendered from the *previous* set
   * stays in state. Playback reads the notes directly and sounds right; export
   * and publish read this blob and ship the old audio. The two disagree and
   * nothing says so.
   *
   * Recording the key turns "remember to invalidate" into "compare", which
   * cannot be forgotten by the next feature.
   */
  renderedKey: string | null;
  renderRealtimeRatio: number | null;
  playing: boolean;
  playheadOrigin: number | null;

  publishedId: string | null;
  shareUrl: string | null;
  manageToken: string | null;

  error: { code: AppError['code']; recovery: AppError['recovery'] } | null;
  storageWarning: boolean;
}

export type Action =
  | { type: 'machine'; event: CreationEvent; payload?: { code: AppError['code']; recovery: AppError['recovery'] } }
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
  | { type: 'rerouteAudio' }
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
      judge?: JudgeVerdict | null;
    }
  | { type: 'setRetouch'; amount: number }
  | { type: 'setVersion'; versionId: VersionId }
  | { type: 'setTempoChoice'; choice: TempoChoice }
  | { type: 'setKey'; key: FlowState['keyOverride'] }
  | { type: 'setInstrument'; id: string }
  | { type: 'setMaster'; master: Partial<MasterSettings> }
  | { type: 'setTitle'; title: string }
  | { type: 'rendered'; blob: Blob; ratio: number; key: string }
  | { type: 'playing'; playing: boolean; origin: number | null }
  | { type: 'published'; id: string; shareUrl: string; manageToken: string }
  | { type: 'unpublished' }
  | { type: 'error'; error: AppError }
  | { type: 'clearError' }
  | { type: 'storageWarning'; low: boolean }
  | { type: 'reset'; id: string };

/**
 * Everything in `FlowState` that describes the source rather than the person.
 *
 * ## Why this is a list and not a comment
 *
 * A user recorded a hum, let it transcribe, switched to Rhythm and imported a
 * rhythmic MIDI. The reducer's `midiImported` case rebuilt `rawNotes` from the
 * file and left `judge` holding the previous recording's verdict — twelve notes,
 * every one at pitch 50. The Teacher resolves its material through
 * `state.judge?.notes ?? state.rawNotes`, so everything downstream of
 * Unprocessed read a melody from a source the user had already replaced. The
 * exported package shows it exactly: 145 events in, 145 in Unprocessed, and
 * twelve in Judge and Teacher.
 *
 * Nothing in the design said `judge` had to be reset. It happened to be reset in
 * the transcription path because somebody remembered, and happened not to be in
 * the import path because somebody did not. Every other source-derived field was
 * one refactor away from the same fate.
 *
 * So the classification is written down. `beginNewSource` clears exactly these,
 * every entry point goes through it, and a test walks the list — which turns
 * "remember to clear the new field" into a failing assertion.
 */
export const SOURCE_DERIVED_FIELDS = [
  'sourceId',
  'sourceSerial',
  'audio',
  'source',
  'durationSec',
  'validation',
  'rawNotes',
  'judge',
  'referenceNotes',
  'rawDrums',
  'diagnostics',
  'melodyQuality',
  'progress',
  'versionId',
  'keyOverride',
  'tempoChoice',
  'renderedAudio',
  'renderedKey',
  'renderRealtimeRatio',
  'playing',
  'playheadOrigin',
] as const;

/**
 * The fields that are *not* cleared, and why they are not.
 *
 * `instrumentId`, `master`, `retouchAmount`, `metronomeMuted` and `title` belong
 * to the person, not the take: someone who chose a cello and turned the reverb
 * down did not choose it for one recording. `bpm`, `meter` and `mode` are
 * session settings that a new source may *replace* — a MIDI file states its own
 * tempo — but does not invalidate. `machine`, `sketchId`, `publishedId` and the
 * share fields describe the sketch rather than the evidence inside it.
 */
export type SourceDerivedField = (typeof SOURCE_DERIVED_FIELDS)[number];

/**
 * The state a newly-arrived source starts from.
 *
 * Spread over the existing state by every entry point that replaces the
 * evidence: a finished recording, an imported audio file, an imported MIDI, and
 * a mode switch that discards the take. Callers then set what the new source
 * actually provides, so the only way to leak a field is to write it back
 * deliberately.
 */
export function beginNewSource(state: FlowState): Pick<FlowState, SourceDerivedField> {
  const sourceSerial = state.sourceSerial + 1;
  return {
    sourceId: `${state.sketchId}#${sourceSerial}`,
    sourceSerial,
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
    versionId: null,
    keyOverride: null,
    tempoChoice: 'performance',
    renderedAudio: null,
    renderedKey: null,
    renderRealtimeRatio: null,
    playing: false,
    playheadOrigin: null,
  };
}

export function initialState(sketchId: string, mode: CreationMode = 'melody'): FlowState {
  return {
    machine: INITIAL_CONTEXT,
    sketchId,
    sourceId: `${sketchId}#1`,
    sourceSerial: 1,
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
    tempoChoice: 'performance',
    keyOverride: null,
    instrumentId: resolveInstrument(undefined, mode).id,
    master: DEFAULT_MASTER,
    renderedAudio: null,
    renderedKey: null,
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

export function reducer(state: FlowState, action: Action): FlowState {
  switch (action.type) {
    case 'machine': {
      const result = transition(state.machine, action.event, action.payload);
      if (!result.accepted) return state;
      return { ...state, machine: result.context };
    }
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
      // The source changes here, not at `transcribed`. A take that then fails to
      // transcribe must not leave the previous take's verdict on screen beside
      // the new recording, which is what happened while the reset lived in the
      // success path.
      return {
        ...state,
        ...beginNewSource(state),
        audio: action.audio,
        source: action.source,
        durationSec: action.audio.durationSec,
        validation: action.validation,
        level: null,
      };
    case 'progress':
      return { ...state, progress: action.progress };
    case 'rerouteAudio': {
      const audio = state.audio;
      const source = state.source;
      const validation = state.validation;
      const durationSec = state.durationSec;
      return {
        ...state,
        ...beginNewSource(state),
        audio,
        source,
        validation,
        durationSec,
      };
    }
    case 'transcribed':
      // Not a new source — the same audio, now understood. `sourceId` is
      // deliberately unchanged, so a Musician result generated from this take
      // survives a reprocess of the very same recording.
      {
        const classification = action.diagnostics.classification?.type;
        const mode: CreationMode = classification
          ? classification === 'rhythm' ? 'rhythm' : 'melody'
          : state.mode;
        return {
          ...state,
          mode,
          melodyInputMode: classification
            ? classification === 'melody' ? 'voice' : 'instrument'
            : state.melodyInputMode,
          instrumentId: mode === state.mode ? state.instrumentId : resolveInstrument(undefined, mode).id,
          rawNotes: action.notes,
          judge: action.judge,
          referenceNotes: action.referenceNotes,
          rawDrums: action.drums,
          diagnostics: action.diagnostics,
          melodyQuality: action.melodyQuality,
          progress: null,
          // A re-read of the take can move every note, so the previous choice of
          // version described a reading that no longer exists. The same goes for a
          // tempo override: it was a judgement about different notes.
          versionId: null,
          tempoChoice: 'performance',
          renderedAudio: null,
          renderedKey: null,
          renderRealtimeRatio: null,
        };
      }
    case 'midiImported':
      return {
        ...state,
        ...beginNewSource(state),
        mode: action.mode,
        bpm: action.bpm,
        // A MIDI file states its own tempo, and a stated tempo is a fact about
        // the music rather than a click track the performer was free to drift
        // from. Detection exists for performances; here there is nothing to
        // detect that the file has not already said. The user can still switch
        // to the detected pulse from the picker.
        tempoChoice: 'metronome',
        meter: action.meter,
        instrumentId: resolveInstrument(undefined, action.mode).id,
        source: action.source,
        durationSec: action.durationSec,
        rawNotes: action.notes,
        judge: action.judge ?? null,
        rawDrums: action.drums,
        diagnostics: action.diagnostics,
      };
    case 'setRetouch':
      return { ...state, retouchAmount: action.amount, renderedAudio: null };
    case 'setVersion':
      return { ...state, versionId: action.versionId, renderedAudio: null };
    case 'setTempoChoice':
      // Changes the grid every version is built on, so the render no longer
      // matches. The render key would catch this anyway; clearing here keeps it
      // consistent with every other input that moves the notes.
      return { ...state, tempoChoice: action.choice, renderedAudio: null };
    case 'setKey':
      return { ...state, keyOverride: action.key, renderedAudio: null };
    case 'setInstrument':
      return { ...state, instrumentId: action.id, renderedAudio: null };
    case 'setMaster':
      return { ...state, master: { ...state.master, ...action.master }, renderedAudio: null };
    case 'setTitle':
      return { ...state, title: action.title };
    case 'rendered':
      return {
        ...state,
        renderedAudio: action.blob,
        renderedKey: action.key,
        renderRealtimeRatio: action.ratio,
      };
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
