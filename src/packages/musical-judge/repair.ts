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

import type { JudgeOctaveConflict, NoteEvent } from '@contracts';
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
  apply(notes: readonly NoteEvent[], features: JudgeFeatures, options?: RepairOptions): NoteEvent[];
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
  /**
   * Frames under a note that must agree with a shifted pitch before the shift
   * may be applied, as a fraction of the measured frames in the span.
   *
   * A correction the audio only half supports is a guess; this floor keeps
   * guesses out of the repair.
   */
  minFoldSupport: number;
  /**
   * How far a frame may sit from a register and still count towards its
   * support.
   *
   * Wider than {@link pitchToleranceSemitones} on purpose: intonation and
   * vibrato routinely sit a semitone off the note name while unmistakably
   * supporting its octave, and a support statistic that only counts
   * dead-on frames would read a well-sung span as split evidence.
   */
  foldSupportToleranceSemitones: number;
  /**
   * How much more of the span the shifted pitch must explain than the note's
   * current pitch, as a fraction. A fold that wins by one frame is rounding,
   * not evidence.
   */
  foldSupportMargin: number;
  /**
   * The candidate's register is itself a measured decision.
   *
   * Set by callers whose notes were produced by the melody pipeline: there the
   * register was chosen from these same frames *plus phrase context* the Judge
   * does not have, so re-deciding it per-note from local frames alone sets up
   * two competing octave authorities. Under this flag the corrector defers —
   * it moves nothing — and `detectOctaveConflicts` reports every register
   * disagreement it sees instead, so the uncertainty is visible rather than
   * silently resolved either way.
   */
  respectCandidateRegister: boolean;
}

export const DEFAULT_REPAIR_OPTIONS: RepairOptions = {
  pitchToleranceSemitones: 0.75,
  fragmentGapSec: 0.09,
  minNoteSec: 0.05,
  // One and two octaves either way: a tracker reports the second and fourth
  // harmonic far more often than anything else.
  octaveCandidates: [-24, -12, 12, 24],
  minFoldSupport: 0.6,
  foldSupportToleranceSemitones: 1.2,
  foldSupportMargin: 0.25,
  respectCandidateRegister: false,
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
 * Share of the measured frames under a span that sit within tolerance of
 * `pitch`. The support statistic the fold guard decides on: it asks not
 * "which octave is the median closer to" but "how much of the span does each
 * register actually explain".
 */
function supportDuring(
  features: JudgeFeatures,
  startSec: number,
  endSec: number,
  pitch: number,
  toleranceSemitones: number,
): { support: number; frames: number } {
  const reference = referencePitchesDuring(features, startSec, endSec);
  if (reference.length === 0) return { support: 0, frames: 0 };
  const agreeing = reference.filter((frame) => Math.abs(frame - pitch) <= toleranceSemitones).length;
  return { support: agreeing / reference.length, frames: reference.length };
}

/**
 * Octave correction.
 *
 * For each note, try the allowed octave shifts and keep whichever the audio's
 * measured frames actually support. Two gates stand between a note and a fold,
 * and they encode where the Judge's authority ends:
 *
 * **The evidence gate.** A shift is applied only when the frames under the
 * note explain the shifted pitch far better than the current one — at least
 * `minFoldSupport` of the span, by at least `foldSupportMargin` over the
 * incumbent. This is what stops a noisy minority reading from dragging a note
 * that four frames out of five contradict. It also refuses the mirror mistake:
 * moving notes *away* from what the audio says, which no median-distance rule
 * alone prevents.
 *
 * **The authority gate.** When `respectCandidateRegister` is set, the caller is
 * saying the candidate's register was itself decided from measurement — the
 * melody pipeline votes with measured frames and folds registers with phrase
 * context the Judge never sees. Re-deciding that per-note from local frames
 * makes the second opinion win despite knowing less, which is how one
 * confidently-tracked subharmonic becomes a whole phrase flipped an octave.
 * Under this flag the corrector moves nothing; the disagreement is reported by
 * {@link detectOctaveConflicts} instead.
 */
export function correctOctaves(
  notes: readonly NoteEvent[],
  features: JudgeFeatures,
  options: Partial<RepairOptions> = DEFAULT_REPAIR_OPTIONS,
): NoteEvent[] {
  const config = { ...DEFAULT_REPAIR_OPTIONS, ...options };
  if (config.respectCandidateRegister) return [...notes];
  return notes.map((note) => {
    let bestPitch = note.pitch;
    let bestSupport = supportDuring(
      features,
      note.startSec,
      note.endSec,
      note.pitch,
      config.foldSupportToleranceSemitones,
    );

    for (const shift of config.octaveCandidates) {
      const candidate = note.pitch + shift;
      if (candidate < 0 || candidate > 127) continue;
      const supported = supportDuring(
        features,
        note.startSec,
        note.endSec,
        candidate,
        config.foldSupportToleranceSemitones,
      );
      // Decisively better explained by the audio, or not moved at all.
      if (
        supported.support >= config.minFoldSupport &&
        supported.support >= bestSupport.support + config.foldSupportMargin
      ) {
        bestSupport = supported;
        bestPitch = candidate;
      }
    }

    return bestPitch === note.pitch ? note : { ...note, pitch: bestPitch };
  });
}

/**
 * Where the transcription's register and the measured audio disagree by an
 * octave family.
 *
 * This is the reporting half of the authority gate: when the corrector defers
 * to the candidate's register, the disagreements it would otherwise have
 * resolved are listed here — with the support numbers that describe how split
 * the evidence is — so a downstream stage or a human can see the uncertainty
 * instead of discovering it as a phrase that will not stay in one octave
 * between builds.
 *
 * Only genuine octave-family conflicts are listed, and only when the frames
 * under the span have a real opinion (enough frames, mostly agreeing with the
 * reference). A note the audio says nothing about is silence, not conflict.
 */
export function detectOctaveConflicts(
  notes: readonly NoteEvent[],
  features: JudgeFeatures,
  options: Partial<RepairOptions> = DEFAULT_REPAIR_OPTIONS,
): JudgeOctaveConflict[] {
  const config = { ...DEFAULT_REPAIR_OPTIONS, ...options };
  const conflicts: JudgeOctaveConflict[] = [];
  for (const note of notes) {
    const reference = medianOfSorted(referencePitchesDuring(features, note.startSec, note.endSec));
    if (reference === null || !isOctaveApart(note.pitch, reference)) continue;
    const noteSupported = supportDuring(
      features,
      note.startSec,
      note.endSec,
      note.pitch,
      config.foldSupportToleranceSemitones,
    );
    const referenceSupported = supportDuring(
      features,
      note.startSec,
      note.endSec,
      reference,
      config.foldSupportToleranceSemitones,
    );
    // The audio must speak clearly for its own register before this counts as
    // a disagreement rather than tracker grit around the note.
    if (referenceSupported.frames < 4 || referenceSupported.support < 0.6) continue;
    conflicts.push({
      startSec: Number(note.startSec.toFixed(3)),
      endSec: Number(note.endSec.toFixed(3)),
      notePitch: note.pitch,
      referenceMedian: Number(reference.toFixed(2)),
      noteSupport: Number(noteSupported.support.toFixed(3)),
      referenceSupport: Number(referenceSupported.support.toFixed(3)),
    });
  }
  return conflicts;
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
    apply: (notes, features, options) => removeUnsupportedNotes(notes, features, options),
  },
  {
    id: 'correct-octaves',
    describe: () => 'moved notes to the octave the audio was actually in',
    apply: (notes, features, options) => correctOctaves(notes, features, options),
  },
  {
    id: 'merge-fragments',
    describe: () => 'merged split notes back into one',
    apply: (notes, features, options) => mergeFragments(notes, features, options),
  },
  {
    id: 'reconstruct-durations',
    describe: () => 'restored note lengths from the audio',
    apply: (notes, features, options) => reconstructDurations(notes, features, options),
  },
];

export function operatorById(id: RepairOperatorId): RepairOperator {
  const operator = REPAIR_OPERATORS.find((candidate) => candidate.id === id);
  if (!operator) throw new Error(`unknown repair operator: ${id}`);
  return operator;
}
