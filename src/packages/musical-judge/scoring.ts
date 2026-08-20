/**
 * How faithfully a set of notes represents the audio it came from.
 *
 * ## What this score is and is not
 *
 * It is **not** a measure of musical quality. A wandering, out-of-tune hum
 * transcribed perfectly scores 1.0, and it should — the question is only
 * whether we understood the human, not whether the human was any good. Making
 * the result *better* is the Music Teacher's job, and keeping the two apart is
 * what lets this half be benchmarked at all.
 *
 * ## Five components, each aimed at a specific observed failure
 *
 * | component | the failure it catches |
 * |---|---|
 * | `pitch` | octave errors, wrong notes |
 * | `timing` | onsets that drifted off the attacks |
 * | `coverage` | sung material with no note at all |
 * | `parsimony` | **harmonic artifacts** — notes with no support in the audio |
 * | `fragmentation` | one held note reported as three |
 *
 * `parsimony` is the one that matters most for the reported symptom. A
 * harmonic reported as a note has a *perfectly good pitch* and a *perfectly
 * good onset*; the only thing wrong with it is that nothing in the audio was
 * ever at that pitch. Only a per-note support test finds it.
 *
 * ## Why the pitch score is frame-aligned rather than DTW
 *
 * DTW is the right tool for comparing two performances that share a shape but
 * not a timeline. Here the candidate MIDI was *derived from this very audio*,
 * so the timelines already align — and warping them would actively hide the
 * rhythm distortion the Judge is supposed to catch. DTW is therefore used only
 * for `melodicShape`, a secondary, timing-independent read reported for
 * diagnostics and never mixed into `overall`.
 */

import type { NoteEvent } from '@contracts';
import {
  medianOfSorted,
  referencePitchesDuring,
  type JudgeFeatures,
} from './features';

export interface JudgeScore {
  /** 0..1 weighted verdict. */
  overall: number;
  pitch: number;
  timing: number;
  coverage: number;
  parsimony: number;
  fragmentation: number;
  /** Timing-independent contour agreement. Diagnostic only. */
  melodicShape: number;
  diagnostics: JudgeDiagnostics;
}

export interface JudgeDiagnostics {
  noteCount: number;
  /** Notes covering no voiced audio, or disagreeing with it beyond tolerance. */
  unsupportedNotes: number;
  /** Notes matching the reference an exact octave away. */
  octaveMismatches: number;
  /** Median absolute pitch error in semitones, over supported notes. */
  medianPitchErrorSemitones: number;
  /** Median absolute onset error in seconds against the nearest audio onset. */
  medianOnsetErrorSec: number;
  /** Voiced reference frames with no note covering them, as a fraction. */
  uncoveredVoicedRatio: number;
  /** Runs of same-pitch notes separated by tiny gaps. */
  fragmentRuns: number;
}

export interface ScoringOptions {
  /** Pitch agreement tolerance in semitones before a note counts as wrong. */
  pitchToleranceSemitones: number;
  /** Onset agreement tolerance in seconds. */
  onsetToleranceSec: number;
  /** Gap below which two same-pitch notes look like one fragmented note. */
  fragmentGapSec: number;
}

export const DEFAULT_SCORING_OPTIONS: ScoringOptions = {
  // Half a semitone: a correct note may sit slightly off from vibrato and
  // rounding, but anything approaching a semitone is a different note.
  pitchToleranceSemitones: 0.75,
  // 50 ms is about the limit of what a listener hears as "together".
  onsetToleranceSec: 0.05,
  fragmentGapSec: 0.09,
};

/**
 * Weights.
 *
 * `parsimony` and `pitch` dominate because they are what the user actually
 * complained about: notes that were never sung, and notes in the wrong octave.
 * `timing` is weighted lower than either — a note in the right place with the
 * wrong pitch is a worse failure than the reverse.
 */
const WEIGHTS = {
  pitch: 0.32,
  parsimony: 0.28,
  coverage: 0.16,
  timing: 0.14,
  fragmentation: 0.1,
} as const;

export function judgeNotes(
  notes: readonly NoteEvent[],
  features: JudgeFeatures,
  options: Partial<ScoringOptions> = {},
): JudgeScore {
  const config = { ...DEFAULT_SCORING_OPTIONS, ...options };

  // Nothing voiced means there is no evidence either way. Scoring such a take
  // as 0 would make the optimizer delete every note chasing an unreachable
  // improvement; scoring it as 1 would claim a perfect understanding of
  // silence. Neither is right, so this is reported as an abstention.
  if (features.voicedFrames === 0) {
    return abstain(notes.length);
  }

  const pitchErrors: number[] = [];
  const onsetErrors: number[] = [];
  let unsupported = 0;
  let octaveMismatches = 0;

  for (const note of notes) {
    const reference = medianOfSorted(referencePitchesDuring(features, note.startSec, note.endSec));

    if (reference === null) {
      // No voiced audio under this note at all: it is an invention.
      unsupported += 1;
      continue;
    }

    const error = Math.abs(note.pitch - reference);
    if (error <= config.pitchToleranceSemitones) {
      pitchErrors.push(error);
    } else if (isOctaveApart(note.pitch, reference)) {
      // Counted separately because it is repairable by a known operator,
      // unlike a note that is simply wrong.
      octaveMismatches += 1;
      unsupported += 1;
    } else {
      unsupported += 1;
      pitchErrors.push(error);
    }

    if (features.onsets.length > 0) {
      onsetErrors.push(nearestDistance(features.onsets, note.startSec));
    }
  }

  const medianPitchError = median(pitchErrors);
  const medianOnsetError = median(onsetErrors);
  const uncovered = uncoveredVoicedRatio(notes, features);
  const fragmentRuns = countFragmentRuns(notes, config.fragmentGapSec);

  const pitch = notes.length === 0 ? 0 : falloff(medianPitchError, config.pitchToleranceSemitones * 2);
  const timing =
    onsetErrors.length === 0 ? 0.5 : falloff(medianOnsetError, config.onsetToleranceSec * 3);
  const coverage = 1 - uncovered;
  const parsimony = notes.length === 0 ? 0 : 1 - unsupported / notes.length;
  const fragmentation = notes.length === 0 ? 1 : 1 - Math.min(1, fragmentRuns / notes.length);

  const overall = clamp01(
    WEIGHTS.pitch * pitch +
      WEIGHTS.parsimony * parsimony +
      WEIGHTS.coverage * coverage +
      WEIGHTS.timing * timing +
      WEIGHTS.fragmentation * fragmentation,
  );

  return {
    overall,
    pitch,
    timing,
    coverage,
    parsimony,
    fragmentation,
    melodicShape: melodicShapeScore(notes, features),
    diagnostics: {
      noteCount: notes.length,
      unsupportedNotes: unsupported,
      octaveMismatches,
      medianPitchErrorSemitones: medianPitchError,
      medianOnsetErrorSec: medianOnsetError,
      uncoveredVoicedRatio: uncovered,
      fragmentRuns,
    },
  };
}

function abstain(noteCount: number): JudgeScore {
  return {
    overall: 0.5,
    pitch: 0.5,
    timing: 0.5,
    coverage: 0.5,
    parsimony: 0.5,
    fragmentation: 0.5,
    melodicShape: 0.5,
    diagnostics: {
      noteCount,
      unsupportedNotes: 0,
      octaveMismatches: 0,
      medianPitchErrorSemitones: 0,
      medianOnsetErrorSec: 0,
      uncoveredVoicedRatio: 0,
      fragmentRuns: 0,
    },
  };
}

/** Exact octave relationship, within the pitch tolerance. */
export function isOctaveApart(a: number, b: number): boolean {
  const distance = Math.abs(a - b);
  if (distance < 6) return false;
  return Math.abs(distance - Math.round(distance / 12) * 12) < 1;
}

/** Fraction of voiced reference frames that no note covers. */
function uncoveredVoicedRatio(notes: readonly NoteEvent[], features: JudgeFeatures): number {
  if (features.voicedFrames === 0) return 0;
  let uncovered = 0;

  for (const frame of features.frames) {
    if (frame.midiPitch === null) continue;
    const covered = notes.some(
      (note) => frame.timeSec >= note.startSec && frame.timeSec <= note.endSec,
    );
    if (!covered) uncovered += 1;
  }
  return clamp01(uncovered / features.frames.filter((f) => f.midiPitch !== null).length);
}

/** Adjacent same-pitch notes separated by a gap too small to be deliberate. */
function countFragmentRuns(notes: readonly NoteEvent[], gapSec: number): number {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  let runs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as NoteEvent;
    const current = sorted[i] as NoteEvent;
    if (current.pitch === previous.pitch && current.startSec - previous.endSec <= gapSec) runs += 1;
  }
  return runs;
}

/**
 * Timing-independent contour agreement, via banded dynamic time warping.
 *
 * Reported for diagnostics only, and deliberately kept out of `overall`:
 * warping the timeline is exactly what would let a rhythmically mangled result
 * score well. It is useful for answering a different question — "is this the
 * right tune, played wrong?" — which is what the Music Teacher will need.
 */
export function melodicShapeScore(
  notes: readonly NoteEvent[],
  features: JudgeFeatures,
): number {
  const candidate = notes
    .slice()
    .sort((a, b) => a.startSec - b.startSec)
    .map((note) => note.pitch);
  const reference = downsampleContour(features, candidate.length || 1);
  if (candidate.length === 0 || reference.length === 0) return 0;

  // Compare *intervals* rather than absolute pitch: a melody transposed
  // wholesale still has the right shape, and the octave test above already
  // covers absolute placement.
  const a = differences(candidate);
  const b = differences(reference);
  if (a.length === 0 || b.length === 0) return candidate.length === reference.length ? 1 : 0;

  const distance = bandedDtw(a, b);
  return falloff(distance / Math.max(a.length, b.length), 3);
}

function differences(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) out.push((values[i] as number) - (values[i - 1] as number));
  return out;
}

/** Reference contour reduced to roughly `target` representative pitches. */
function downsampleContour(features: JudgeFeatures, target: number): number[] {
  const voiced = features.frames
    .filter((frame) => frame.midiPitch !== null)
    .map((frame) => frame.midiPitch as number);
  if (voiced.length === 0) return [];
  const step = Math.max(1, Math.floor(voiced.length / Math.max(1, target)));
  const out: number[] = [];
  for (let i = 0; i < voiced.length; i += step) {
    out.push(voiced[i] as number);
  }
  return out;
}

/**
 * Sakoe-Chiba banded DTW. O(n * band) rather than O(n^2), which keeps this
 * cheap enough to run inside the optimizer's scoring loop.
 */
export function bandedDtw(a: readonly number[], b: readonly number[], band = 8): number {
  const n = a.length;
  const m = b.length;
  const width = Math.max(band, Math.abs(n - m) + 1);
  const INF = Number.POSITIVE_INFINITY;

  let previous = new Float64Array(m + 1).fill(INF);
  let current = new Float64Array(m + 1).fill(INF);
  previous[0] = 0;

  for (let i = 1; i <= n; i += 1) {
    current.fill(INF);
    const from = Math.max(1, i - width);
    const to = Math.min(m, i + width);
    for (let j = from; j <= to; j += 1) {
      const cost = Math.abs((a[i - 1] as number) - (b[j - 1] as number));
      const best = Math.min(
        previous[j] as number,
        current[j - 1] as number,
        previous[j - 1] as number,
      );
      current[j] = cost + (Number.isFinite(best) ? best : 0);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  const result = previous[m] as number;
  return Number.isFinite(result) ? result : Math.max(n, m) * 12;
}

function nearestDistance(sorted: readonly number[], value: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of sorted) {
    const distance = Math.abs(candidate - value);
    if (distance < best) best = distance;
    // The list is sorted; once we start moving away we are done.
    else if (candidate > value) break;
  }
  return Number.isFinite(best) ? best : 0;
}

/** 1 at zero error, falling to 0 at `scale`. */
function falloff(error: number, scale: number): number {
  if (!Number.isFinite(error)) return 0;
  return clamp01(1 - error / scale);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
