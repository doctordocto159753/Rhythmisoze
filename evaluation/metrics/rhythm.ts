/**
 * Rhythm evaluation metrics.
 *
 * The rhythm path is judged on the only two things a sketchbook needs from it:
 * did the hits land where the performer played them (precision/recall), and how
 * far off the survivors are (timing deviation). Both are computed against
 * synthesised ground truth with known hit times, so a number here is a
 * measurement, not an opinion.
 */

export interface OnsetMetrics {
  referenceOnsets: number;
  estimatedOnsets: number;
  precision: number;
  recall: number;
  f1: number;
  /** Median |estimated − true| across matches, in milliseconds. */
  medianDeviationMs: number;
}

/**
 * Greedy nearest-onset matching within `toleranceSec`. Stable for the pulse
 * densities this corpus uses; ties break toward the earliest estimate.
 */
export function computeOnsetMetrics(
  referenceTimes: readonly number[],
  estimatedTimes: readonly number[],
  toleranceSec = 0.05,
): OnsetMetrics {
  const used = new Set<number>();
  const deviations: number[] = [];

  for (const refTime of referenceTimes) {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    estimatedTimes.forEach((estTime, index) => {
      if (used.has(index)) return;
      const delta = Math.abs(estTime - refTime);
      if (delta < bestDelta && delta <= toleranceSec) {
        bestDelta = delta;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      deviations.push(bestDelta * 1000);
    }
  }

  const precision = ratio(deviations.length, estimatedTimes.length);
  const recall = ratio(deviations.length, referenceTimes.length);
  return {
    referenceOnsets: referenceTimes.length,
    estimatedOnsets: estimatedTimes.length,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    medianDeviationMs: median(deviations),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
