/**
 * Two measurements, pulling against each other.
 *
 * **Coherence** asks whether the melody got better. **Identity** asks whether it
 * is still the same melody. The Teacher's whole job is to raise the first
 * without lowering the second past a floor, and a suggestion that fails either
 * test is discarded.
 *
 * ## Honesty about what coherence is
 *
 * The Judge could be benchmarked because it had ground truth: the audio. The
 * Teacher has none — "would a music teacher suggest this?" is a judgement, not
 * a measurement.
 *
 * So `coherence` is explicitly a **proxy**, not a verdict. It measures four
 * things that correlate with a phrase sounding deliberate, and it is used only
 * to *compare two versions of the same melody* — never to claim a melody is
 * good. That narrow use is defensible; treating the number as a quality score
 * would not be.
 *
 * This is also why the rule order is fixed rather than searched: searching
 * would optimise this proxy directly, which is how a layer like this ends up
 * serving its own metric instead of the music.
 */

import type { NoteEvent } from '@contracts';
import type { MelodyAnalysis } from '../analysis';
import type { MelodyIdentity, MusicalCoherence } from '../types';

const COHERENCE_WEIGHTS = {
  scaleConformance: 0.34,
  rhythmicRegularity: 0.28,
  intervalSmoothness: 0.22,
  phraseClarity: 0.16,
} as const;

export function scoreCoherence(
  notes: readonly NoteEvent[],
  analysis: MelodyAnalysis,
): MusicalCoherence {
  const scaleConformance = scoreScaleConformance(notes, analysis);
  const intervalSmoothness = scoreIntervalSmoothness(notes);
  const rhythmicRegularity = scoreRhythmicRegularity(notes, analysis);
  const phraseClarity = scorePhraseClarity(notes, analysis);

  return {
    scaleConformance,
    intervalSmoothness,
    rhythmicRegularity,
    phraseClarity,
    overall: clamp01(
      COHERENCE_WEIGHTS.scaleConformance * scaleConformance +
        COHERENCE_WEIGHTS.rhythmicRegularity * rhythmicRegularity +
        COHERENCE_WEIGHTS.intervalSmoothness * intervalSmoothness +
        COHERENCE_WEIGHTS.phraseClarity * phraseClarity,
    ),
  };
}

/** Duration-weighted, because a long wrong note is more wrong than a passing one. */
function scoreScaleConformance(notes: readonly NoteEvent[], analysis: MelodyAnalysis): number {
  const key = analysis.key;
  // No trusted key means no opinion. Returning a middling score rather than 0
  // stops a modal or chromatic melody from being scored as incoherent for
  // failing to be diatonic.
  if (key === null) return 0.5;

  let inside = 0;
  let total = 0;
  for (const note of notes) {
    const weight = Math.max(0.05, note.endSec - note.startSec);
    total += weight;
    if (key.scalePitchClasses.includes(((note.pitch % 12) + 12) % 12)) inside += weight;
  }
  return total > 0 ? inside / total : 0.5;
}

/**
 * Whether leaps behave the way sung melodies do.
 *
 * Not "small intervals are better" — that would score a monotone as perfect.
 * What is measured is whether large leaps are *resolved*: a leap followed by a
 * step in the opposite direction is the classic shape, and it is what makes a
 * wide interval sound intended rather than accidental.
 */
function scoreIntervalSmoothness(notes: readonly NoteEvent[]): number {
  if (notes.length < 3) return 0.7;

  const intervals: number[] = [];
  for (let i = 1; i < notes.length; i += 1) {
    intervals.push((notes[i] as NoteEvent).pitch - (notes[i - 1] as NoteEvent).pitch);
  }

  let score = 0;
  let counted = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    const interval = intervals[i] as number;
    const size = Math.abs(interval);
    counted += 1;

    if (size <= 2) {
      // Stepwise motion: always idiomatic.
      score += 1;
      continue;
    }
    if (size > 12) {
      // Beyond an octave in one move is almost never sung deliberately.
      score += 0.1;
      continue;
    }

    const next = intervals[i + 1];
    if (next === undefined) {
      score += 0.6;
      continue;
    }
    // Resolved in the opposite direction: the leap was prepared for.
    const resolved = Math.sign(next) === -Math.sign(interval) && Math.abs(next) <= 4;
    score += resolved ? 0.95 : 0.45;
  }

  return counted > 0 ? clamp01(score / counted) : 0.7;
}

/** How consistently onsets sit on the melody's own grid. */
function scoreRhythmicRegularity(notes: readonly NoteEvent[], analysis: MelodyAnalysis): number {
  const step = analysis.gridStepSec;
  const rhythm = analysis.rhythm;
  if (step === null || step <= 0 || rhythm === null || notes.length < 2) return 0.5;

  const phase = rhythm.tempo.phaseSec;
  let total = 0;
  for (const note of notes) {
    const offset = note.startSec - phase;
    const drift = Math.abs(offset - Math.round(offset / step) * step);
    // Perfect on the grid scores 1, half a step off scores 0.
    total += clamp01(1 - drift / (step * 0.5));
  }
  return clamp01(total / notes.length);
}

/**
 * Whether phrases end the way phrases do: on a note held longer than the ones
 * before it.
 */
function scorePhraseClarity(notes: readonly NoteEvent[], analysis: MelodyAnalysis): number {
  if (analysis.phrases.length === 0) return 0.5;

  let total = 0;
  let counted = 0;
  for (const phrase of analysis.phrases) {
    if (phrase.endIndex - phrase.startIndex < 2) continue;
    const last = notes[phrase.endIndex];
    if (last === undefined) continue;

    const lastDuration = last.endSec - last.startSec;
    let bodyTotal = 0;
    let bodyCount = 0;
    for (let i = phrase.startIndex; i < phrase.endIndex; i += 1) {
      const note = notes[i];
      if (!note) continue;
      bodyTotal += note.endSec - note.startSec;
      bodyCount += 1;
    }
    if (bodyCount === 0) continue;

    const ratio = lastDuration / (bodyTotal / bodyCount);
    // 1.0 and above reads as a settled ending; well under reads as clipped.
    total += clamp01(ratio / 1.3);
    counted += 1;
  }

  return counted > 0 ? clamp01(total / counted) : 0.5;
}

/**
 * How much of the original melody survived.
 *
 * The four measures answer four different ways a revision can go wrong: too
 * many notes touched, the shape changed, one note moved too far, or the
 * harmonic content drifted. All four have to hold — an average would let a
 * catastrophic failure in one hide behind three good scores, so the aggregate
 * is deliberately the **minimum-weighted** combination rather than a mean.
 */
export function scoreIdentity(
  original: readonly NoteEvent[],
  revised: readonly NoteEvent[],
): MelodyIdentity {
  if (original.length === 0 || original.length !== revised.length) {
    // A different note count is not a revision of this melody at all.
    return {
      notesUnchanged: 0,
      contourPreserved: 0,
      maxPitchShiftSemitones: 0,
      pitchClassOverlap: 0,
      overall: 0,
    };
  }

  let unchanged = 0;
  let maxShift = 0;
  for (let i = 0; i < original.length; i += 1) {
    const before = original[i] as NoteEvent;
    const after = revised[i] as NoteEvent;
    const shift = Math.abs(after.pitch - before.pitch);
    maxShift = Math.max(maxShift, shift);
    if (
      shift === 0 &&
      Math.abs(after.startSec - before.startSec) < 0.005 &&
      Math.abs(after.endSec - before.endSec) < 0.005
    ) {
      unchanged += 1;
    }
  }

  const notesUnchanged = unchanged / original.length;
  const contourPreserved = scoreContour(original, revised);
  const pitchClassOverlap = scorePitchClassOverlap(original, revised);
  // A whole tone is the largest single move any rule may make; beyond that the
  // note has become a different note.
  const shiftPenalty = clamp01(1 - Math.max(0, maxShift - 2) / 4);

  return {
    notesUnchanged,
    contourPreserved,
    maxPitchShiftSemitones: maxShift,
    pitchClassOverlap,
    // The weakest signal dominates: identity is not an average, it is a set of
    // conditions that all have to hold.
    overall: clamp01(
      Math.min(
        0.55 + notesUnchanged * 0.45,
        contourPreserved,
        shiftPenalty,
        0.4 + pitchClassOverlap * 0.6,
      ),
    ),
  };
}

/** Agreement between the two melodies' direction of travel. */
function scoreContour(original: readonly NoteEvent[], revised: readonly NoteEvent[]): number {
  if (original.length < 2) return 1;
  let agree = 0;
  let total = 0;
  for (let i = 1; i < original.length; i += 1) {
    const before = Math.sign(
      (original[i] as NoteEvent).pitch - (original[i - 1] as NoteEvent).pitch,
    );
    const after = Math.sign((revised[i] as NoteEvent).pitch - (revised[i - 1] as NoteEvent).pitch);
    total += 1;
    if (before === after) agree += 1;
    // A step that flattened to a repeat is a partial change of shape, not a
    // reversal, so it is not scored as harshly as an inversion.
    else if (before === 0 || after === 0) agree += 0.5;
  }
  return total > 0 ? agree / total : 1;
}

/** Duration-weighted overlap of the two pitch-class profiles. */
function scorePitchClassOverlap(
  original: readonly NoteEvent[],
  revised: readonly NoteEvent[],
): number {
  const a = pitchClassProfile(original);
  const b = pitchClassProfile(revised);
  let overlap = 0;
  for (let i = 0; i < 12; i += 1) overlap += Math.min(a[i] as number, b[i] as number);
  return clamp01(overlap);
}

function pitchClassProfile(notes: readonly NoteEvent[]): number[] {
  const profile = new Array<number>(12).fill(0);
  let total = 0;
  for (const note of notes) {
    const weight = Math.max(0.05, note.endSec - note.startSec);
    const pitchClass = ((note.pitch % 12) + 12) % 12;
    profile[pitchClass] = (profile[pitchClass] as number) + weight;
    total += weight;
  }
  if (total > 0) for (let i = 0; i < 12; i += 1) profile[i] = (profile[i] as number) / total;
  return profile;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
