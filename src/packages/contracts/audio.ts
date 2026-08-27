/**
 * Audio + processing contracts.
 *
 * The processor adapter (Playbook §6.4) lives here so that the UI never talks
 * to Basic Pitch, a pitch tracker or a future server endpoint directly.
 */

import type { DrumEvent, MusicalPhraseModel, NoteEvent, OnsetEvent, RawTranscription } from './music';

/**
 * The single internal audio representation. Everything upstream (MediaRecorder
 * blobs, uploaded files, decoded AudioBuffers) is converted to this before any
 * DSP or ML runs, so the pipeline behaves the same across browser codecs.
 */
export interface MonoAudio {
  /** Mono float PCM, nominally -1..1 but not guaranteed to be normalized. */
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}

export interface AudioDiagnostics {
  durationSec: number;
  sampleRate: number;
  /** Absolute peak, 0..1+. Values above 1 indicate the capture already clipped. */
  peak: number;
  /** Root-mean-square over the whole clip. */
  rms: number;
  /** Fraction of samples at or above the clipping threshold, 0..1. */
  clippedRatio: number;
  /** Fraction of 20 ms frames below the silence floor, 0..1. */
  silentRatio: number;
  /** Loudest 20 ms frame RMS. Used to judge "quiet but usable" vs "empty". */
  loudestFrameRms: number;
}

export type AudioValidationCode =
  | 'ok'
  | 'too_short'
  | 'silent'
  | 'mostly_silent'
  | 'clipped'
  | 'decode_failed';

export interface AudioValidation {
  code: AudioValidationCode;
  /** `false` only when the material genuinely cannot be transcribed. */
  usable: boolean;
  diagnostics: AudioDiagnostics;
}

export type TranscriberId =
  | 'game'
  | 'melody-extraction'
  | 'basic-pitch'
  | 'basic-pitch-yin'
  | 'pitch-tracker'
  | 'midi-import'
  | 'server';

export type ProcessingBackend = 'browser' | 'server';

/** Which acoustic assumption the transcription engine should make. */
export type TranscriptionInputMode = 'auto' | 'voice' | 'instrument' | 'rhythm';

/** Internal material classification. This is routing evidence, not a user mode. */
export type InputType = 'melody' | 'polyphonic' | 'rhythm' | 'mixed' | 'unknown';

export interface InputClassification {
  type: InputType;
  /** 0..1 confidence in the selected route. */
  confidence: number;
  /** Human-readable evidence for debugging and misclassification reports. */
  reasoning: string[];
  /** Optional normalized scores retained for diagnostics. */
  scores?: Record<InputType, number>;
  /** Optional numeric evidence retained for diagnostics. */
  features?: Record<string, number>;
  /** Whether this route came from evidence or a correction made after review. */
  method?: 'automatic' | 'user-corrected';
  /** The automatic recommendation replaced by a user correction. */
  originalType?: InputType;
}

export interface MelodyConfidence {
  melodyConfidence: number;
  estimatedNotes: number;
  range: string | null;
  clear: boolean;
  voicedFramePercentage: number;
  pitchContinuity: number;
  octaveStability: number;
  segmentationConfidence: number;
}

export interface TranscriptionOptions {
  mode: TranscriptionInputMode;
  /** Confidence floor for accepting a note, 0..1. */
  noteThreshold?: number;
  /** Onset sensitivity, 0..1. Higher means fewer, stronger onsets. */
  onsetThreshold?: number;
  /** Shortest note the transcriber is allowed to emit, in seconds. */
  minNoteLengthSec?: number;
  signal?: AbortSignal;
}

export interface ProcessingDiagnostics {
  transcriberId: TranscriberId;
  backend: ProcessingBackend;
  /** Wall-clock milliseconds spent inside the transcriber. */
  elapsedMs: number;
  /** Milliseconds spent loading the model, 0 when served from cache. */
  modelLoadMs: number;
  /** True when the model came from a warm cache rather than the network. */
  modelFromCache: boolean;
  notesBeforeFilter: number;
  notesAfterFilter: number;
  warnings: string[];
  /** How the source was routed. Absent on saved results produced before auto-routing. */
  classification?: InputClassification;
  /**
   * Per-note record of what the later stages changed about the candidate,
   * bounded in length. Observability for the debug views; absent when the
   * pipeline had nothing to report.
   */
  noteTransformations?: NoteTransformation[];
}

/**
 * One mechanical change a pipeline stage made to the candidate note set.
 *
 * Deliberately dumb: a diff of two note lists with a stage label, not an
 * interpretation. The debug views assemble the story; this only guarantees the
 * facts survive to them.
 */
export interface NoteTransformation {
  /** Stage that produced `after` from `before` — e.g. "judge", "teacher". */
  stage: string;
  kind: 'removed' | 'added' | 'pitch-shifted' | 'moved';
  startSec: number;
  endSec: number;
  /** Absent for additions. */
  fromPitch?: number;
  /** Absent for removals. */
  toPitch?: number;
}

/**
 * One place where the transcription's register and the measured audio disagree
 * by an octave family, reported instead of silently repaired.
 *
 * Reported rather than folded because both readings claim the same evidence:
 * the note's register was chosen by the extraction stage from these very
 * frames plus phrase context, and a second stage re-deciding it from a subset
 * of that information is how one wrong octave becomes two.
 */
export interface JudgeOctaveConflict {
  startSec: number;
  endSec: number;
  /** The transcription's pitch — the register the extraction stage settled on. */
  notePitch: number;
  /** Median measured pitch under the note's span. */
  referenceMedian: number;
  /** Share of measured frames under the span agreeing with `notePitch`, 0..1. */
  noteSupport: number;
  /** Share of measured frames agreeing with `referenceMedian`, 0..1. */
  referenceSupport: number;
}

/**
 * A faithfulness verdict, produced by `@musical-judge`.
 *
 * Deliberately structural rather than a bare number: a score with no account of
 * what was wrong, or what was done about it, cannot be argued with.
 */
export interface JudgeVerdict {
  /** Repaired notes. Equal to the candidate when nothing improved it. */
  notes: NoteEvent[];
  /** 0..1 faithfulness of the repaired notes. */
  score: number;
  /** 0..1 faithfulness of the candidate, before repair. */
  scoreBefore: number;
  /** Ordered, human-readable account of what was changed. */
  repairs: string[];
  unsupportedNotesRemoved: number;
  octaveErrorsCorrected: number;
  /**
   * Register disagreements the Judge observed and deliberately did not
   * resolve, because the transcription's register is itself a measured
   * decision. Empty when none were seen or when repair was allowed to act.
   */
  octaveConflicts?: JudgeOctaveConflict[];
}

export interface TranscriptionResult {
  /** Immutable authoritative material. Derived stages must read, never replace, it. */
  rawTranscription?: RawTranscription;
  notes: NoteEvent[];
  /**
   * Evidence-preserving interpretation of continuity for pitched material.
   * Absent for rhythm-only sources and older saved/transcribed results.
   */
  phraseModel?: MusicalPhraseModel;
  /**
   * Independent monophonic reference extracted from the source audio.
   * Retouch uses it as a quality guard; it is never rendered directly unless
   * the model has no trustworthy candidate for a voiced segment.
   */
  referenceNotes?: NoteEvent[];
  /** Present for Human Voice Melody Extraction results. */
  melodyQuality?: MelodyConfidence;
  /**
   * The Judge's verdict on `notes`, and its repair of them.
   *
   * Voice uses independent contour evidence. Polyphonic audio and exact MIDI
   * use a conservative fidelity verdict that never applies monophonic repair.
   * `notes` above is always the untouched candidate: the verdict lives here so
   * the product can offer both without one overwriting the other.
   */
  judge?: JudgeVerdict;
  onsets?: OnsetEvent[];
  drums?: DrumEvent[];
  durationSec: number;
  diagnostics: ProcessingDiagnostics;
}

export type TranscriptionStage =
  | 'loading_model'
  | 'preparing_audio'
  | 'inferring'
  | 'collecting'
  | 'done';

export interface TranscriptionProgress {
  stage: TranscriptionStage;
  /** 0..1 within the whole transcription, not within the stage. */
  progress: number;
}

export interface AudioTranscriber {
  readonly id: TranscriberId;
  readonly backend: ProcessingBackend;
  /** Resolves false when the environment cannot run this transcriber at all. */
  isAvailable(): Promise<boolean>;
  transcribe(
    input: MonoAudio,
    options: TranscriptionOptions,
    onProgress?: (p: TranscriptionProgress) => void,
  ): Promise<TranscriptionResult>;
}
