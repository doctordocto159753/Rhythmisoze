/**
 * Sketch contracts — the persisted shape of a user's work.
 *
 * `LocalSketch` never leaves the device. `PublishedSketch` is the subset that
 * becomes public, and it deliberately has no field that could carry the raw
 * microphone recording.
 */

import type { CreationMode, DrumEvent, GridDivision, KeyMode, Meter, NoteEvent, PitchClassName } from './music';

/**
 * 3 adds the Musician versions.
 *
 * Every field it introduces is optional, so a version-2 row is already a valid
 * version-3 row -- the migration is a re-stamp, not a rewrite. That matters
 * more than it sounds: a migration that has to reshape rows is a migration that
 * can lose them, and there is no server copy of this data to restore from.
 */
export const LOCAL_SCHEMA_VERSION = 3 as const;
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

export type SourceKind = 'recording' | 'audio-upload' | 'midi-upload';

/**
 * The exact bytes the user supplied. This remains local and is deliberately
 * absent from PublishedSketch; it exists so the original can be exported and
 * recovered without pretending a rendered WAV is the source take.
 */
export interface LocalSourceAsset {
  kind: SourceKind;
  filename: string;
  mimeType: string;
  blob: Blob;
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
  /** Original recording/upload. Never published. */
  source?: LocalSourceAsset;
  midi?: Blob;
  createdAt: number;
  updatedAt: number;
  publishedId?: string;
  schemaVersion: number;
  /**
   * Musician output, when it has been generated.
   *
   * Stored rather than derived: unlike the other versions these notes cannot be
   * recomputed, because the same seed against a different model revision is a
   * different result. Absent on every sketch made before the feature existed,
   * and on every sketch where the user never asked for it.
   */
  musician?: StoredMusician;
  /** Which version the user was last listening to. */
  selectedVersionId?: string;
}

/** Persisted Musician state. See `@versions` for the note-level shapes. */
export interface StoredMusician {
  /** The accepted pair, keyed by version id. */
  versions: Record<string, StoredMusicianVersion>;
  /** In-flight job, so a reopened workspace can resume polling. */
  job?: {
    jobId: string | null;
    phase: string;
    attempt: number;
    /** Lets a stale job be recognised rather than polled forever. */
    startedAt: number;
  };
}

export interface StoredMusicianVersion {
  notes: NoteEvent[];
  identityAggregate: number;
  changedSpans: { startIndex: number; endIndex: number; reason: string }[];
  provenance: {
    jobId: string;
    seed: number;
    serviceVersion: string;
    melodyModelRevision: string;
    infillModelRevision: string;
    sourceFingerprint: string;
    generatedAt: number;
    elapsedMs: number;
  };
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
