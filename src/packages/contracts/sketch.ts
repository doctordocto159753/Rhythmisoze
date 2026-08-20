/**
 * Sketch contracts — the persisted shape of a user's work.
 *
 * `LocalSketch` never leaves the device. `PublishedSketch` is the subset that
 * becomes public, and it deliberately has no field that could carry the raw
 * microphone recording.
 */

import type { CreationMode, DrumEvent, GridDivision, KeyMode, Meter, NoteEvent, PitchClassName } from './music';

export const LOCAL_SCHEMA_VERSION = 1 as const;
export const PUBLISHED_SCHEMA_VERSION = 1 as const;

export type Locale = 'fa' | 'en';

export interface RetouchSettings {
  /** The single user-facing control, 0..100. See packages/retouch/macro.ts. */
  amount: number;
  /** Grid the macro resolved to, exposed for diagnostics and export. */
  grid: GridDivision;
  /** User override of the detected key, when they corrected it (Q-B4). */
  keyOverride?: { root: PitchClassName; mode: KeyMode };
}

export interface SketchAnalysis {
  keyRoot: PitchClassName;
  keyMode: KeyMode;
  keyConfidence: number;
  /** Tempo the retouch engine measured from the take, for comparison with the
   *  user's tapped BPM. The tapped BPM stays authoritative (Playbook §2.5). */
  detectedBpm: number;
  gridError: number;
  lowestPitch: number;
  highestPitch: number;
  noteCount: number;
  octaveErrorsRemoved: number;
  notesSnapped: number;
  notesMerged: number;
  repeatedMovePercent: number;
  stepwiseMovePercent: number;
}

export interface LocalSketch {
  id: string;
  title: string;
  locale: Locale;
  bpm: number;
  meter: Meter;
  mode: CreationMode;
  instrumentId: string;
  retouch: RetouchSettings;
  /** Raw transcriber output. Kept so retouch strength stays non-destructive. */
  rawNotes: NoteEvent[];
  rawDrums: DrumEvent[];
  analysis: SketchAnalysis | null;
  durationSec: number;
  /** Rendered WAV, cached locally. Dropped first when storage is tight. */
  renderedAudio?: Blob;
  midi?: Blob;
  createdAt: number;
  updatedAt: number;
  publishedId?: string;
  schemaVersion: number;
}

export interface PublishedSketch {
  id: string;
  title: string;
  bpm: number;
  mode: CreationMode;
  keyRoot: PitchClassName | null;
  keyMode: KeyMode | null;
  instrumentId: string;
  audioUrl: string;
  midiUrl: string;
  durationSec: number;
  createdAt: string;
  playCount: number;
  schemaVersion: number;
}

/** Returned once, at publish time only. Q-C1: anonymous publish + delete token. */
export interface PublishReceipt {
  sketch: PublishedSketch;
  shareUrl: string;
  manageToken: string;
}
