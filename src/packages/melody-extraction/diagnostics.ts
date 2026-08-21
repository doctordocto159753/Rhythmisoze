/**
 * Measuring an Audio→MIDI reading against the contour it came from.
 *
 * ## Why "it sounds better" is not enough
 *
 * The failure this package was rebuilt to fix was invisible to listening: the
 * notes that *were* emitted had good pitch — a median error near a fifth of a
 * semitone — so the reading sounded plausible. What was wrong is that most of
 * the performance was not represented at all, and a melody with two thirds of
 * itself missing still sounds like a melody. It takes a number to see that.
 *
 * So these are the six numbers that separate the ways a transcription can be
 * wrong, kept apart because improving one at the cost of another is the easiest
 * thing in the world to do by accident:
 *
 * ```
 * pitchErrorSemitones   is the pitch right where we did emit a note?
 * voicedRecall          how much of the performance became notes at all?
 * falseVoicedRatio      how much note time has no pitched audio under it?
 * onsetErrorSec         do note starts land where the sound starts?
 * fragmentationRatio    is one sustained pitch being cut into pieces?
 * mergeRatio            are two different pitches being averaged into one?
 * ```
 *
 * Recall and false-voiced move against each other, and so do fragmentation and
 * merge. A change that improves one of a pair while wrecking the other has not
 * improved anything, which is exactly what "just lower the threshold" does.
 *
 * ## What counts as the truth here
 *
 * `TrustedRegion[]` — spans of known pitch. Tests build them from what they
 * synthesised. For a real recording there is no ground truth, so
 * `trustedRegionsFromContour` derives them from the tracker's own candidates
 * where those are locally stable: not an independent opinion, but a strictly
 * weaker one, since it only claims "a steady pitch was measurable here" and
 * says nothing about which note the person meant.
 */

import type { NoteEvent } from '@contracts';
import type { PitchFrame } from './pitch-tracker';

export interface TrustedRegion {
  startSec: number;
  endSec: number;
  /** The pitch believed to be sounding, in MIDI semitones (not rounded). */
  midiPitch: number;
}

export interface TranscriptionMetrics {
  /**
   * Median absolute difference between an emitted note's pitch and the trusted
   * pitch under it. `NaN` when no note overlapped any trusted region.
   */
  pitchErrorSemitones: number;
  /** Fraction of trusted time covered by some note, 0..1. */
  voicedRecall: number;
  /** Fraction of note time with no trusted region under it, 0..1. */
  falseVoicedRatio: number;
  /** Median distance from a trusted region's start to the nearest note start. */
  onsetErrorSec: number;
  /**
   * Notes per trusted region, minus one, floored at zero.
   *
   * One region answered by one note scores 0. A sustained pitch cut into four
   * scores 3. Counts only notes whose pitch matches the region, so a genuine
   * neighbouring note is not read as a fragment of this one.
   */
  fragmentationRatio: number;
  /**
   * Fraction of trusted regions that share a note with a differently-pitched
   * neighbour.
   *
   * The opposite failure: two notes averaged into one, which shows up as one
   * note straddling two regions whose pitches differ.
   */
  mergeRatio: number;
  /** How many trusted regions had no note at all. */
  missedRegions: number;
  trustedRegions: number;
  notes: number;
}

/** How close a note's pitch must be to a region's to be answering it. */
const PITCH_MATCH_SEMITONES = 1.5;

export function measureTranscription(
  notes: readonly NoteEvent[],
  trusted: readonly TrustedRegion[],
): TranscriptionMetrics {
  const trustedTime = trusted.reduce((sum, region) => sum + span(region), 0);
  const noteTime = notes.reduce((sum, note) => sum + Math.max(0, note.endSec - note.startSec), 0);

  let coveredTime = 0;
  let matchedTime = 0;
  const pitchErrors: number[] = [];
  const onsetErrors: number[] = [];
  let fragments = 0;
  let missed = 0;
  let merged = 0;

  for (const region of trusted) {
    const answering = notes.filter(
      (note) =>
        overlap(note.startSec, note.endSec, region.startSec, region.endSec) > 0 &&
        Math.abs(note.pitch - region.midiPitch) <= PITCH_MATCH_SEMITONES,
    );
    const anyOverlapping = notes.filter(
      (note) => overlap(note.startSec, note.endSec, region.startSec, region.endSec) > 0,
    );

    for (const note of answering) {
      const shared = overlap(note.startSec, note.endSec, region.startSec, region.endSec);
      coveredTime += shared;
      matchedTime += shared;
      pitchErrors.push(Math.abs(note.pitch - region.midiPitch));
    }
    for (const note of anyOverlapping) {
      if (answering.includes(note)) continue;
      coveredTime += overlap(note.startSec, note.endSec, region.startSec, region.endSec);
    }

    if (answering.length === 0) missed += 1;
    else fragments += answering.length - 1;

    if (anyOverlapping.length > 0) {
      const nearest = anyOverlapping.reduce((best, note) =>
        Math.abs(note.startSec - region.startSec) < Math.abs(best.startSec - region.startSec)
          ? note
          : best,
      );
      onsetErrors.push(Math.abs(nearest.startSec - region.startSec));
    }

    // A note that also covers a region of a different pitch has merged them.
    const straddles = anyOverlapping.some((note) =>
      trusted.some(
        (other) =>
          other !== region &&
          Math.abs(other.midiPitch - region.midiPitch) > PITCH_MATCH_SEMITONES &&
          overlap(note.startSec, note.endSec, other.startSec, other.endSec) > 0,
      ),
    );
    if (straddles) merged += 1;
  }

  return {
    pitchErrorSemitones: median(pitchErrors),
    voicedRecall: trustedTime > 0 ? clamp01(coveredTime / trustedTime) : 0,
    falseVoicedRatio: noteTime > 0 ? clamp01(1 - matchedTime / noteTime) : 0,
    onsetErrorSec: median(onsetErrors),
    fragmentationRatio: trusted.length > 0 ? fragments / trusted.length : 0,
    mergeRatio: trusted.length > 0 ? merged / trusted.length : 0,
    missedRegions: missed,
    trustedRegions: trusted.length,
    notes: notes.length,
  };
}

export interface TrustedContourOptions {
  /** Minimum clarity for a candidate to be considered measurable at all. */
  minClarity: number;
  /** Frames either side used to test local stability. */
  windowFrames: number;
  /** Maximum spread across that window, in semitones, to call it stable. */
  maxSpreadSemitones: number;
  /** Shortest run of stable frames worth calling a region. */
  minRegionSec: number;
}

export const DEFAULT_TRUSTED_CONTOUR_OPTIONS: TrustedContourOptions = {
  minClarity: 0.4,
  windowFrames: 4,
  maxSpreadSemitones: 0.9,
  minRegionSec: 0.08,
};

/**
 * The stable pitched material a take contains, from the tracker's own candidates.
 *
 * Deliberately not an independent transcription. It answers one narrow
 * question — *was a steady pitch measurable here?* — using evidence the tracker
 * already produced, and that is the question note coverage is about. Using a
 * second pitch tracker instead would mean scoring disagreements between two
 * trackers as transcription failures, which is a different and less useful
 * measurement.
 */
export function trustedRegionsFromContour(
  frames: readonly PitchFrame[],
  overrides: Partial<TrustedContourOptions> = {},
): TrustedRegion[] {
  const options = { ...DEFAULT_TRUSTED_CONTOUR_OPTIONS, ...overrides };
  const hopSec = hopOf(frames);
  const stable = frames.map((frame, index) => {
    if (frame.candidateMidi === null || frame.clarity < options.minClarity) return false;
    const window = frames
      .slice(Math.max(0, index - options.windowFrames), index + options.windowFrames + 1)
      .map((neighbour) => neighbour.candidateMidi)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    if (window.length < options.windowFrames + 2) return false;
    // Trimmed spread, so one outlier inside the window does not disqualify a
    // region that is otherwise steady.
    const spread = (window.at(-2) as number) - (window[1] as number);
    return spread <= options.maxSpreadSemitones;
  });

  const regions: TrustedRegion[] = [];
  let index = 0;
  while (index < frames.length) {
    if (!stable[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < frames.length && stable[index]) index += 1;
    const run = frames.slice(start, index);
    const startSec = (run[0] as PitchFrame).timeSec;
    const endSec = (run.at(-1) as PitchFrame).timeSec + hopSec;
    if (endSec - startSec < options.minRegionSec) continue;
    const pitches = run
      .map((frame) => frame.candidateMidi)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    regions.push({ startSec, endSec, midiPitch: median(pitches) });
  }
  return regions;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function span(region: TrustedRegion): number {
  return Math.max(0, region.endSec - region.startSec);
}

function hopOf(frames: readonly PitchFrame[]): number {
  const hops: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const hop = (frames[index]?.timeSec ?? 0) - (frames[index - 1]?.timeSec ?? 0);
    if (hop > 0) hops.push(hop);
  }
  hops.sort((a, b) => a - b);
  return hops[Math.floor(hops.length / 2)] ?? 0.01;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
