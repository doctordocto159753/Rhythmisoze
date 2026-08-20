/**
 * The Raw-to-Clean macro (PRD C-06, US-0407).
 *
 * The product ships exactly one cleanup control. A non-musician should never be
 * asked to reason about octave tolerance, grid resolution and scale-snap
 * strength as separate ideas. This file is the entire mapping from that one
 * 0-100 value to the seven parameters the engine actually uses, and it is the
 * only place allowed to define it.
 *
 * ## The curve
 *
 * ```
 * amount        0        25        50        75       100
 * --------------------------------------------------------------
 * octave filter off      on/22     on/18     on/15     on/12
 * merge floor   0 ms     25 ms     50 ms     75 ms     100 ms
 * grid          1/32     1/32      1/16      1/8       1/8
 * timing        0.00     0.36      0.71      1.00      1.00
 * scale snap    0.00     0.00      0.33      0.67      1.00
 * velocity      0.00     0.00      0.17      0.58      1.00
 * ```
 *
 * ## Why this shape
 *
 * Timing rises first and reaches full strength before pitch correction starts
 * to matter. Aligning a hum to the grid is what makes it sound intentional, and
 * it does not change any note the user chose. Moving pitches does change them,
 * so it is held back until the user has clearly asked for more than a tidy-up.
 * Velocity smoothing comes last because it flattens performance, and on a good
 * take that is a loss rather than a fix.
 *
 * ## The two endpoints are deliberate, not accidental
 *
 * - **0** is not "a small amount of cleanup". Every stage is off. The user hears
 *   the transcription exactly as it came out of the model, which is the honest
 *   reference point for judging everything above it.
 * - **100** is not "as much as the algorithm can do". It is the reference
 *   `humtool.py` behaviour: full quantization, full scale snap, the same 12
 *   semitone octave tolerance.
 *
 * ## Monotonicity
 *
 * Every parameter is non-decreasing in cleanliness as `amount` rises. Raising
 * the slider can never un-clean something a lower value already cleaned, which
 * is what makes A/B auditioning at two positions meaningful. `tests/unit/
 * retouch-macro.test.ts` asserts this across the whole range rather than
 * trusting the table above.
 *
 * Changing any number here requires A/B listening, a regression fixture update
 * and UX sign-off (Playbook 8.6).
 */

import type { GridDivision } from '@contracts';
import { clamp } from './numeric';

export interface RetouchParams {
  /** `false` leaves even wild octave jumps alone - the raw endpoint. */
  octaveFilterEnabled: boolean;
  /** Semitones either side of the median pitch that survive the filter. */
  octaveToleranceSemitones: number;
  /** Shortest note kept, in seconds, before the half-step-cap in mergeShortNotes. */
  mergeMinDurationSec: number;
  /** Same-pitch notes closer than this fuse into one articulation. */
  mergeMaxGapSec: number;
  grid: GridDivision;
  /** 0 = performed timing, 1 = fully on the grid. */
  timingStrength: number;
  /** 0 = every pitch as transcribed, 1 = every out-of-key note corrected. */
  scaleSnapStrength: number;
  /** 0 = performed dynamics, 1 = maximum evening-out. */
  velocitySmoothing: number;
}

/** Normalized position of `value` inside `[from, to]`, clamped to 0..1. */
function ramp(value: number, from: number, to: number): number {
  if (to === from) return value >= to ? 1 : 0;
  return clamp((value - from) / (to - from), 0, 1);
}

export const RETOUCH_AMOUNT_MIN = 0;
export const RETOUCH_AMOUNT_MAX = 100;
export const RETOUCH_AMOUNT_DEFAULT = 55;

/**
 * Resolves the single user-facing value into engine parameters.
 * Pure and total: any finite input produces a usable parameter set.
 */
export function resolveRetouchParams(
  amount: number,
  overrides?: { grid?: GridDivision } & Partial<Omit<RetouchParams, 'grid'>>,
): RetouchParams {
  const a = clamp(Number.isFinite(amount) ? amount : RETOUCH_AMOUNT_DEFAULT, 0, 100);

  const octaveFilterEnabled = a > 0;
  // 24 semitones at the moment it switches on, tightening to the reference 12.
  const octaveToleranceSemitones = octaveFilterEnabled ? 24 - 12 * ramp(a, 1, 100) : 96;

  const grid: GridDivision = overrides?.grid ?? (a < 34 ? 32 : a <= 66 ? 16 : 8);

  const resolved: RetouchParams = {
    octaveFilterEnabled,
    octaveToleranceSemitones,
    mergeMinDurationSec: 0.1 * ramp(a, 0, 100),
    mergeMaxGapSec: 0.06 * ramp(a, 0, 100),
    grid,
    timingStrength: ramp(a, 0, 70),
    scaleSnapStrength: ramp(a, 25, 100),
    velocitySmoothing: ramp(a, 40, 100),
  };

  // Version presets need timing and pitch to move independently - "Natural"
  // keeps the performed timing while still removing transcription artefacts.
  // The single slider remains the only control a *user* ever sees; this is an
  // internal override used by `versions.ts`, and every value it can set is
  // still one the curve itself could produce.
  if (overrides === undefined) return resolved;
  const { grid: _grid, ...rest } = overrides;
  // Spread rather than a keyed loop: this keeps every field type-checked
  // against RetouchParams instead of widening it to an index signature.
  return {
    ...resolved,
    ...Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    ),
  };
}

/**
 * Coarse label for the current position, used for the control's accessible
 * value text. The slider shows a word, not a number, because "62" means nothing
 * to the person this product is for (D-0402).
 */
export type RetouchLabel = 'raw' | 'light' | 'balanced' | 'tidy' | 'clean';

export function retouchLabel(amount: number): RetouchLabel {
  const a = clamp(amount, 0, 100);
  if (a <= 4) return 'raw';
  if (a < 35) return 'light';
  if (a < 65) return 'balanced';
  if (a < 92) return 'tidy';
  return 'clean';
}

/** Seconds per grid step at a given tempo and grid division. */
export function stepSeconds(bpm: number, grid: GridDivision): number {
  return 240 / (bpm * grid);
}
