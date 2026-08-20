/**
 * Numeric helpers that reproduce CPython / NumPy semantics exactly.
 *
 * The retouch engine is a *port* of `humtool.py`, not a rewrite (Playbook §8.5).
 * A port that silently uses JavaScript's rounding or modulo rules is not a port:
 * it drifts by a grid step here and a semitone there, and the golden fixtures
 * stop meaning anything. Everything in this file exists to prevent that.
 */

/**
 * CPython's `round()` — round-half-to-even ("banker's rounding").
 * `Math.round(0.5)` is 1 and `Math.round(-0.5)` is -0; Python gives 0 for both.
 * Note onsets land exactly on `.5` of a grid step often enough that this
 * matters in practice, not just in theory.
 */
export function pyRound(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Exactly halfway: pick the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * CPython's `statistics.median` — mean of the two central values on even input,
 * not the lower one. `strip_octave_errors` and `percussion_map` both branch on
 * this, so the half-integer case changes which notes survive.
 */
export function pyMedian(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of empty sequence');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Python's `%` — the result carries the sign of the divisor, so it is never negative here. */
export function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Python's `//` on floats. */
export function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

/**
 * `np.roll(values, shift)` — rotate right. `result[i] = values[(i - shift) mod n]`.
 * Key detection rotates the Krumhansl-Schmuckler profile by each of the 12
 * roots; rotating the wrong way transposes every detected key.
 */
export function roll(values: readonly number[], shift: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) out[i] = values[mod(i - shift, n)] as number;
  return out;
}

/**
 * Pearson correlation, matching `np.corrcoef(a, b)[0, 1]`.
 * Returns NaN when either input has zero variance — exactly as NumPy does.
 * Callers must decide what an undefined correlation means; this function does
 * not invent a value.
 */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return Number.NaN;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i] as number;
    meanB += b[i] as number;
  }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let devA = 0;
  let devB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] as number) - meanA;
    const db = (b[i] as number) - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }
  const den = Math.sqrt(devA) * Math.sqrt(devB);
  if (den === 0) return Number.NaN;
  return num / den;
}

/** Sum of an array, used where the Python source sums a generator. */
export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation with `t` clamped to 0..1. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * clamp(t, 0, 1);
}
