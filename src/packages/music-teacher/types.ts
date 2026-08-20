/**
 * The Music Teacher's vocabulary.
 *
 * ## What this layer is
 *
 * A music teacher hears a student's idea and suggests improvements. They do not
 * write a new piece, and they do not hand back something the student would not
 * recognise. That is the entire brief, and it is also the constraint that makes
 * this layer safe to ship.
 *
 * ## The invariant that makes it safe
 *
 * **V1 never adds a note and never removes one.** It only adjusts the pitch,
 * timing, duration or velocity of notes that are already there.
 *
 * That is a strong restriction, and it is deliberate. The moment a layer can
 * add notes it is composing, and "did it preserve the melody?" stops having a
 * checkable answer. With the note count fixed, identity is measurable: the
 * result is the same melody if the same notes are still in the same order with
 * the same shape.
 *
 * ## Why every edit carries a reason
 *
 * The Judge can be benchmarked against the audio — there is a right answer. The
 * Teacher has no ground truth: "would a teacher suggest this?" is a judgement.
 * The honest substitute for a benchmark is an explanation. Every change says
 * what it did and why, so a musician can disagree with a specific decision
 * rather than with a black box.
 */

import type { KeyMode, NoteEvent, PitchClassName } from '@contracts';

export type TeacherEditKind =
  | 'pitch-to-scale'
  | 'timing-to-grid'
  | 'duration-regularised'
  | 'phrase-ending-lengthened'
  | 'motif-aligned';

export interface TeacherEdit {
  /** Index into the *input* note array, so an edit can be traced back. */
  noteIndex: number;
  kind: TeacherEditKind;
  /** What changed, in the units of the thing that changed. */
  from: number;
  to: number;
  /** Plain-language justification, shown to the user. */
  reason: string;
}

export interface MelodyIdentity {
  /** 0..1. Fraction of notes with pitch and timing untouched. */
  notesUnchanged: number;
  /**
   * 0..1. Agreement between the original and revised melodic direction.
   * A rising phrase must still rise; this is the strongest single signal that
   * the tune survived.
   */
  contourPreserved: number;
  /** Largest single pitch move, in semitones. */
  maxPitchShiftSemitones: number;
  /** 0..1. Overlap of the duration-weighted pitch-class profiles. */
  pitchClassOverlap: number;
  /** 0..1 aggregate. Below `IDENTITY_FLOOR` the revision is rejected outright. */
  overall: number;
}

export interface MusicalCoherence {
  /** 0..1. Duration-weighted share of the melody inside the detected key. */
  scaleConformance: number;
  /** 0..1. Whether leaps are prepared and resolved the way singers phrase. */
  intervalSmoothness: number;
  /** 0..1. How consistently onsets sit on the melody's own grid. */
  rhythmicRegularity: number;
  /** 0..1. Whether phrases end on a long, stable note. */
  phraseClarity: number;
  overall: number;
}

export interface TeacherResult {
  /** Exactly what was handed in. Never mutated. */
  inputNotes: NoteEvent[];
  /** The revised melody. Same length as `inputNotes`, always. */
  notes: NoteEvent[];
  edits: TeacherEdit[];
  coherenceBefore: MusicalCoherence;
  coherenceAfter: MusicalCoherence;
  identity: MelodyIdentity;
  /** The key the suggestions were made in, when one was confidently found. */
  key: { root: PitchClassName; mode: KeyMode; confidence: number } | null;
  /** `true` when nothing was confident enough to suggest. */
  unchanged: boolean;
}

/**
 * Identity floor.
 *
 * A revision that scores below this is discarded and the input is returned. The
 * value is high because the failure it prevents is the one that would destroy
 * trust in the whole feature: handing someone back a melody they do not
 * recognise as theirs.
 */
export const IDENTITY_FLOOR = 0.82;

/**
 * The largest share of notes the Teacher may touch.
 *
 * A teacher who rewrites half of a student's phrase has stopped teaching and
 * started composing. A third is generous for genuine corrections and still
 * leaves the melody's identity intact.
 */
export const MAX_EDITED_FRACTION = 0.34;

/** No single suggestion may move a note further than a whole tone. */
export const MAX_PITCH_SHIFT_SEMITONES = 2;
