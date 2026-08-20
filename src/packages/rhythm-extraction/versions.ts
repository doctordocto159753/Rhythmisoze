/**
 * Performance versions.
 *
 * ## The rule this file enforces
 *
 * **The original human performance is never destroyed.** Every version is a
 * separate interpretation computed from the same untouched source, and the
 * source itself is always one of the options. Choosing "Grid" does not discard
 * "Natural"; it sits beside it.
 *
 * That is the whole answer to the tempo argument. The metronome no longer wins,
 * and neither does the detector — the user does, by ear, from a small set of
 * honestly labelled results:
 *
 * ```
 * Performed        96 BPM   exactly as sung, artefacts removed
 * Natural          96 BPM   the performance's own pulse, lightly settled
 * Tight            96 BPM   the same pulse, timing pulled in
 * Grid            120 BPM   the tempo the user tapped, fully quantized
 * ```
 *
 * Note that Natural and Tight share the *detected* tempo, and only Grid uses
 * the tapped one. If detection is unreliable, Grid is still offered and the
 * others fall back to the tapped tempo with `tempoSource: 'tapped'` recorded,
 * so the UI never claims a tempo was heard when it was not.
 */

import type { CreationMode, GridDivision } from '@contracts';
import type { RetouchParams } from '@retouch';
import { TEMPO_CONFIDENCE_FLOOR } from './tempo';
import type { PerformanceRhythm } from './analyze';

export type VersionId = 'performed' | 'natural' | 'tight' | 'grid';

export const VERSION_IDS: readonly VersionId[] = ['performed', 'natural', 'tight', 'grid'];

export type TempoSource = 'detected' | 'tapped';

export interface VersionRecipe {
  id: VersionId;
  /** The tempo this version is built on. */
  bpm: number;
  tempoSource: TempoSource;
  /** Value for the single Raw-to-Clean control. */
  amount: number;
  gridOverride?: GridDivision;
  /** Internal per-parameter overrides; see `resolveRetouchParams`. */
  paramOverrides?: Partial<Omit<RetouchParams, 'grid'>>;
}

export interface VersionPlanInput {
  rhythm: PerformanceRhythm;
  /** What the user tapped. Never discarded, always offered as "Grid". */
  tappedBpm: number;
  mode: CreationMode;
  /** The user's cleanup position, which still scales every version. */
  amount: number;
}

/**
 * Builds the set of versions to offer.
 *
 * Deterministic and pure: the same performance always produces the same menu,
 * which is what lets the review screen re-render without recomputing audio and
 * what makes the whole thing testable.
 */
export function planVersions(input: VersionPlanInput): VersionRecipe[] {
  const { rhythm, tappedBpm, amount } = input;
  const detected = rhythm.tempo.bpm;
  const useDetected = rhythm.reliable;
  const performanceBpm = useDetected ? detected : tappedBpm;
  const tempoSource: TempoSource = useDetected ? 'detected' : 'tapped';

  // How loose the performance actually was decides how much "Tight" has to do.
  // A steady performer barely needs pulling in; a loose one needs more, and
  // applying the same fixed strength to both is how a good take gets flattened.
  const looseness = 1 - rhythm.groove.steadiness;
  const tightTiming = clamp01(0.45 + looseness * 0.45);

  const recipes: VersionRecipe[] = [
    {
      // The reference point. Artefacts removed, nothing musical touched: no
      // quantization, no scale snapping, no dynamics flattening.
      id: 'performed',
      bpm: performanceBpm,
      tempoSource,
      amount: Math.min(amount, 18),
      paramOverrides: {
        timingStrength: 0,
        scaleSnapStrength: 0,
        velocitySmoothing: 0,
      },
    },
    {
      // The performance's own pulse, with the timing only settled enough to
      // remove tracking jitter rather than human feel.
      id: 'natural',
      bpm: performanceBpm,
      tempoSource,
      amount,
      paramOverrides: {
        timingStrength: 0.2,
        scaleSnapStrength: clamp01(amount / 100) * 0.5,
        velocitySmoothing: 0.15,
      },
    },
    {
      id: 'tight',
      bpm: performanceBpm,
      tempoSource,
      amount,
      paramOverrides: {
        timingStrength: tightTiming,
        scaleSnapStrength: clamp01(amount / 100) * 0.8,
        velocitySmoothing: 0.4,
      },
    },
    {
      // Fully on the grid, at the tempo the user asked for. This is the old
      // behaviour, now one option rather than the only one.
      id: 'grid',
      bpm: tappedBpm,
      tempoSource: 'tapped',
      amount: Math.max(amount, 70),
      paramOverrides: {
        timingStrength: 1,
        velocitySmoothing: 0.6,
      },
    },
  ];

  return recipes;
}

/**
 * The version to select when the user has not chosen.
 *
 * "Natural" when the performance had a pulse worth keeping; "Grid" when it did
 * not, because a take with no detectable tempo is exactly the case where the
 * user's tapped grid is the more useful interpretation.
 */
export function defaultVersion(rhythm: PerformanceRhythm): VersionId {
  return rhythm.reliable ? 'natural' : 'grid';
}

/**
 * Whether the detected and tapped tempos disagree enough to be worth saying.
 *
 * A half- or double-time relationship is the most common and the most
 * interesting: it usually means the user tapped eighths while singing quarters,
 * and telling them that is more useful than silently picking one.
 */
export interface TempoDisagreement {
  kind: 'none' | 'half-or-double' | 'different';
  detectedBpm: number;
  tappedBpm: number;
}

export function compareTempos(rhythm: PerformanceRhythm, tappedBpm: number): TempoDisagreement {
  const detected = rhythm.tempo.bpm;
  const base = { detectedBpm: detected, tappedBpm };
  if (!rhythm.reliable) return { ...base, kind: 'none' };

  const ratio = detected / tappedBpm;
  if (Math.abs(ratio - 1) < 0.06) return { ...base, kind: 'none' };
  if (Math.abs(ratio - 0.5) < 0.08 || Math.abs(ratio - 2) < 0.12) {
    return { ...base, kind: 'half-or-double' };
  }
  return { ...base, kind: 'different' };
}

export { TEMPO_CONFIDENCE_FLOOR };

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
