/**
 * Repair operators.
 *
 * Four deterministic transformations, each aimed at one observed failure. Every
 * one is a pure function from notes to notes, so the optimizer can apply them
 * in any order, score the result and back out of a choice that did not help.
 *
 * ## The constraint that shapes all four
 *
 * **None of these may invent musical content.** They delete, move by an octave,
 * merge, and trim — all operations that can be justified frame by frame against
 * the reference contour. None of them adds a note, changes a pitch to something
 * not present in the audio, or adjusts anything toward a key or a grid.
 *
 * Doing any of that would be the Music Teacher's job, and mixing it in here
 * would destroy the one property that makes this layer measurable: if the Judge
 * is allowed to make the result *nicer*, its score stops telling us whether we
 * understood the human.
 */

import type { NoteEvent } from '@contracts';
import {
  medianOfSorted,
  referencePitchesDuring,
  voicedEndAfter,
  type JudgeFeatures,
} from './features';
import { isOctaveApart } from './scoring';

export type RepairOperatorId =
  | 'remove-unsupported'
  | 'correct-octaves'
  | 'merge-fragments'
  | 'reconstruct-durations';

export interface RepairOperator {
  id: RepairOperatorId;
  /** Human-readable, used in the repair log shown in diagnostics. */
  describe(): string;
  apply(notes: readonly NoteEvent[], features: JudgeFeatures): NoteEvent[];
}

export interface RepairOptions {
  /** Pitch disagreement, in semitones, above which a note counts unsupported. */
  pitchToleranceSemitones: number;
  /** Same-pitch notes closer than this are one fragmented note. */
  fragmentGapSec: number;
  /** Notes shorter than this are candidates for removal when also unsupported. */
  minNoteSec: number;
  /** Octave shifts the corrector is allowed to try. */
  octaveCandidates: number[];
}

export const DEFAULT_REPAIR_OPTIONS: RepairOptions = {
  pitchToleranceSemitones: 0.75,
  fragmentGapSec: 0.09,
  minNoteSec: 0.05,
  // One and two octaves either way: a tracker reports the second and fourth
  // harmonic far more often than anything else.
  octaveCandidates: [-24, -12, 12, 24],
};

/**
 * Harmonic removal.
 *
 * A harmonic reported as a note is not detectable by looking at the note: its
 * pitch is musically sensible and its onset is real. What gives it away is that
 * **the audio was never at that pitch** — the fundamental was an octave or a
 * twelfth below it the whole time. So support is tested against the reference
 * contour under the note's own span.
 *
 * A note is removed only when it disagrees beyond tolerance *and* no octave
 * shift would rescue it. Anything an octave away is left for the octave
 * corrector, which can repair it instead of deleting the user's material.
 */
export function removeUnsupportedNotes(
  notes: readonly NoteEvent[],
  features: JudgeFeatures,
  options: RepairOptions = DEFAULT_REPAIR_OPTIONS,
): NoteEvent[] {
  return notes.filter((note) => {
    const reference = medianOfSorted(referencePitchesDuring(features, note.startSec, note.endSec));

    // No voiced audio underneath: an invention, unless it is long enough that
    // deleting it would lose a real held note the tracker simply lost.
    if (reference === null) return note.endSec - note.startSec < options.minNoteSec * 4;

    const error = Math.abs(note.pitch - reference);
    if (error <= options.pitchToleranceSemitones) return true;
    // Repairable by transposition; leave it for the octave corrector.
    if (isOctaveApart(note.pitch, reference)) return true;
    return false;
  });
}

/**
 * Octave correction.
 *
 * For each note, try the allowed octave shifts and keep whichever sits closest
 * to the reference contour under that note. Per-note rather than global,
 * because a tracker slips on individual notes rather than on a whole take.
 *
 * A shift is applied only if it is a real improvement, so a note already
 * agreeing with the contour is never moved.
 */
export function correctOctaves(
  notes: readonly NoteEvent[],
  features: JudgeFeatures,
  options: RepairOptions = DEFAULT_REPAIR_OPTIONS,
): NoteEvent[] {
  return notes.map((note) => {
    const reference = medianOfSorted(referencePitchesDuring(features, note.startSec, note.endSec));
    if (reference === null) return note;

    let bestPitch = note.pitch;
    let bestError = Math.abs(note.pitch - reference);

    for (const shift of options.octaveCandidates) {
      const candidate = note.pitch + shift;
      if (candidate < 0 || candidate > 127) continue;
      const error = Math.abs(candidate - reference);
      // Strictly better, by a margin, so rounding cannot cause a pointless move.
      if (error < bestError - 0.01) {
        bestError = error;
        bestPitch = candidate;
      }
    }

    return bestPitch === note.pitch ? note : { ...note, pitch: bestPitch };
  });
}

/**
 * Fragment merging.
 *
 * Three consecutive 90 ms E4s with 20 ms between them are one held E4 that the
 * segmenter cut up. Merging is only correct when the gap is too short to be a
 * deliberate re-articulation, which is what `fragmentGapSec` encodes.
 *
 * The merged note keeps the earliest start, the latest end and the loudest
 * velocity — a re-attacked note is at least as loud as its quietest fragment.
 */
export function mergeFragments(
  notes: readonly NoteEvent[],
  _features: JudgeFeatures,
  options: RepairOptions = DEFAULT_REPAIR_OPTIONS,
): NoteEvent[] {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
  const out: NoteEvent[] = [];

  for (const note of sorted) {
    const previous = out[out.length - 1];
    const mergeable =
      previous !== undefined &&
      previous.pitch === note.pitch &&
      note.startSec - previous.endSec <= options.fragmentGapSec;

    if (mergeable) {
      previous.endSec = Math.max(previous.endSec, note.endSec);
      previous.velocity = Math.max(previous.velocity, note.velocity);
      continue;
    }
    out.push({ ...note });
  }
  return out;
}

/**
 * Duration reconstruction.
 *
 * A note's end is decided by three pieces of evidence, in order of authority:
 *
 *  1. **The next note's onset.** A monophonic line cannot overlap itself, so a
 *     note never outlasts its successor's start.
 *  2. **Where the voiced audio stopped.** A note may not outlast the sound that
 *     produced it.
 *  3. **Its existing end**, if neither of the above shortens it.
 *
 * Notes are also extended, not only trimmed: a segmenter that cut a note short
 * at 200 ms when the singer held it for 900 ms is just as wrong as one that ran
 * a note past its sound.
 */
export function reconstructDurations(
  notes: readonly NoteEvent[],
  features: JudgeFeatures,
  options: RepairOptions = DEFAULT_REPAIR_OPTIONS,
): NoteEvent[] {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);

  return sorted.map((note, index) => {
    const next = sorted[index + 1];
    // The note's own pitch, so the search for where its sound ends cannot walk
    // into the next note's evidence and swallow it.
    const voicedEnd = voicedEndAfter(features, note.startSec, note.pitch);

    let end = voicedEnd ?? note.endSec;
    if (next !== undefined) end = Math.min(end, next.startSec);
    // Never shorter than the floor, and never past the clip.
    end = Math.min(features.durationSec, Math.max(note.startSec + options.minNoteSec, end));

    return end === note.endSec ? note : { ...note, endSec: end };
  });
}

export const REPAIR_OPERATORS: readonly RepairOperator[] = [
  {
    id: 'remove-unsupported',
    describe: () => 'removed notes with no support in the audio',
    apply: (notes, features) => removeUnsupportedNotes(notes, features),
  },
  {
    id: 'correct-octaves',
    describe: () => 'moved notes to the octave the audio was actually in',
    apply: (notes, features) => correctOctaves(notes, features),
  },
  {
    id: 'merge-fragments',
    describe: () => 'merged split notes back into one',
    apply: (notes, features) => mergeFragments(notes, features),
  },
  {
    id: 'reconstruct-durations',
    describe: () => 'restored note lengths from the audio',
    apply: (notes, features) => reconstructDurations(notes, features),
  },
];

export function operatorById(id: RepairOperatorId): RepairOperator {
  const operator = REPAIR_OPERATORS.find((candidate) => candidate.id === id);
  if (!operator) throw new Error(`unknown repair operator: ${id}`);
  return operator;
}
