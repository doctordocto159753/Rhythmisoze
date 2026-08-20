/**
 * Audio + processing contracts.
 *
 * The processor adapter (Playbook §6.4) lives here so that the UI never talks
 * to Basic Pitch, a pitch tracker or a future server endpoint directly.
 */

import type { DrumEvent, NoteEvent, OnsetEvent } from './music';

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

export type TranscriberId = 'basic-pitch' | 'pitch-tracker' | 'server';

export type ProcessingBackend = 'browser' | 'server';

export interface TranscriptionOptions {
  mode: 'melody' | 'rhythm';
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
}

export interface TranscriptionResult {
  notes: NoteEvent[];
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
