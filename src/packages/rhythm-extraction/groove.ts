/**
 * Groove: how a performance sits against its own grid.
 *
 * Tempo says where the beats are. Groove says how the player relates to them —
 * consistently early, consistently late, swung, or simply loose. The product
 * needs this for one reason: to be able to *keep* it. "Natural" and "Tight" are
 * only meaningfully different if the system knows what the human actually did
 * and can choose how much of it to preserve.
 */

import type { WeightedOnset } from './tempo';

export interface GrooveProfile {
  /**
   * Mean signed offset from the nearest grid position, in fractions of a beat.
   * Negative means the performer is consistently ahead of the beat.
   */
  meanOffsetBeats: number;
  /**
   * Spread of those offsets. Low means metronomic, high means loose. This is
   * the number that decides how much correction "Tight" should apply.
   */
  deviationBeats: number;
  /**
   * Swing ratio of the off-beat eighths, where 0.5 is straight and 0.66 is
   * triplet swing. `null` when there are too few off-beats to tell.
   */
  swingRatio: number | null;
  /** 0..1. How steady the performance is against its own detected tempo. */
  steadiness: number;
}

/** Minimum off-beat events before a swing ratio means anything. */
const MIN_OFFBEATS_FOR_SWING = 4;

export function analyzeGroove(
  onsets: readonly WeightedOnset[],
  bpm: number,
  phaseSec: number,
): GrooveProfile {
  const beatSec = 60 / bpm;
  if (onsets.length === 0 || beatSec <= 0) {
    return { meanOffsetBeats: 0, deviationBeats: 0, swingRatio: null, steadiness: 0 };
  }

  const offsets: number[] = [];
  const offbeatPositions: number[] = [];

  for (const onset of onsets) {
    const beatsFromPhase = (onset.timeSec - phaseSec) / beatSec;
    // Position inside the beat, 0..1.
    const within = beatsFromPhase - Math.floor(beatsFromPhase);
    // Signed distance to the nearest eighth-note position.
    const nearestEighth = Math.round(within * 2) / 2;
    offsets.push(within - nearestEighth);

    // An eighth that sits between beats is the one swing acts on.
    if (within > 0.25 && within < 0.75) offbeatPositions.push(within);
  }

  const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
  const variance =
    offsets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / offsets.length;
  const deviation = Math.sqrt(variance);

  return {
    meanOffsetBeats: round4(mean),
    deviationBeats: round4(deviation),
    swingRatio: swingOf(offbeatPositions),
    // A deviation of a quarter beat is completely loose; zero is a machine.
    steadiness: clamp01(1 - deviation / 0.25),
  };
}

/**
 * Where the off-beat eighths actually fall.
 *
 * Straight eighths sit at 0.5 of the beat; triplet swing pushes them to ~0.667.
 * Reported as the raw median rather than snapped to a named feel, because a
 * real performance lands between the two more often than on either.
 */
function swingOf(offbeats: readonly number[]): number | null {
  if (offbeats.length < MIN_OFFBEATS_FOR_SWING) return null;
  const sorted = [...offbeats].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return round4(median);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
