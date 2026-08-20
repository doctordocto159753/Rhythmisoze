/**
 * US-0201 / US-0202 - tap tempo.
 *
 * The PRD calls R-02 and R-03 the two most important clauses in the document,
 * and it is right: automatic tempo estimation on unaccompanied humming was
 * measured swinging between 68, 84 and 174 BPM on the same take. Everything
 * downstream - the grid, the count-in, the metronome, the exported MIDI tempo -
 * hangs off the number this file produces, so it is deliberately boring,
 * deterministic and fully unit-tested.
 *
 * The function is pure: the caller supplies timestamps. That keeps it testable
 * and lets the UI feed it a monotonic clock rather than `Date.now()`.
 */

import { BPM_MAX, BPM_MIN, type Meter } from '@contracts';

export interface TapTempoOptions {
  /** Taps needed before a tempo is reported at all (PRD R-02: at least four). */
  minTaps: number;
  /** Taps kept in the rolling window. Older ones stop influencing the result. */
  maxTaps: number;
  /** A gap longer than this ends the phrase and starts a new one. */
  resetAfterSec: number;
  /** Intervals this far from the median are dropped as stumbles. */
  outlierRatio: number;
}

export const DEFAULT_TAP_OPTIONS: TapTempoOptions = {
  minTaps: 4,
  // Eight taps is two bars of 4/4: long enough to average out a shaky start,
  // short enough that a user correcting their tempo is followed quickly.
  maxTaps: 8,
  resetAfterSec: 2.5,
  outlierRatio: 1.7,
};

export interface TapTempoResult {
  /** Null until `minTaps` taps have landed inside one phrase. */
  bpm: number | null;
  /** Taps currently in the window, for the "2 more taps" style hint. */
  tapCount: number;
  /** True when this tap started a fresh phrase. */
  didReset: boolean;
  /** Intervals discarded as stumbles, so the UI can stay calm about them. */
  outliersDropped: number;
}

/**
 * Folds a new tap timestamp (seconds, monotonic) into the tap history.
 * Returns the new history and the tempo; the caller owns the state.
 */
export function tapTempo(
  history: readonly number[],
  timeSec: number,
  options: TapTempoOptions = DEFAULT_TAP_OPTIONS,
): { history: number[]; result: TapTempoResult } {
  const last = history[history.length - 1];
  const didReset = last !== undefined && timeSec - last > options.resetAfterSec;
  const base = didReset ? [] : history;
  const next = [...base, timeSec].slice(-options.maxTaps);

  return { history: next, result: { ...bpmFromTaps(next, options), didReset } };
}

/** Tempo implied by a set of tap timestamps. Exported for direct testing. */
export function bpmFromTaps(
  taps: readonly number[],
  options: TapTempoOptions = DEFAULT_TAP_OPTIONS,
): Omit<TapTempoResult, 'didReset'> {
  if (taps.length < options.minTaps) {
    return { bpm: null, tapCount: taps.length, outliersDropped: 0 };
  }

  const intervals: number[] = [];
  for (let i = 1; i < taps.length; i += 1) {
    intervals.push((taps[i] as number) - (taps[i - 1] as number));
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianInterval =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;

  // A missed tap doubles one interval and a double-tap halves one. The median
  // is immune to both, so it is the reference the outlier test uses.
  const kept = intervals.filter(
    (interval) =>
      interval > 0 &&
      interval <= medianInterval * options.outlierRatio &&
      interval >= medianInterval / options.outlierRatio,
  );
  const usable = kept.length > 0 ? kept : intervals;
  const mean = usable.reduce((total, i) => total + i, 0) / usable.length;
  if (!Number.isFinite(mean) || mean <= 0) {
    return { bpm: null, tapCount: taps.length, outliersDropped: 0 };
  }

  return {
    bpm: clampBpm(Math.round(60 / mean)),
    tapCount: taps.length,
    outliersDropped: intervals.length - kept.length,
  };
}

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 90;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
}

/** Seconds per beat. */
export function beatSeconds(bpm: number): number {
  return 60 / bpm;
}

/** Seconds in one bar of the given meter. */
export function barSeconds(bpm: number, meter: Meter): number {
  return (60 / bpm) * meter.beatsPerBar * (4 / meter.beatUnit);
}

/** Length of the one-measure count-in (PRD R-04). */
export function countInSeconds(bpm: number, meter: Meter): number {
  return barSeconds(bpm, meter);
}
