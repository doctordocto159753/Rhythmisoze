/**
 * Minimal iterative radix-2 FFT plus the window and spectral helpers the onset
 * detector needs.
 *
 * Written rather than pulled in: the whole requirement is a real FFT over
 * power-of-two frames, this is forty lines of it, and a dependency here would
 * have to be justified against Playbook 24 for no gain. It is also the piece
 * most worth having under direct test.
 */

/** In-place complex FFT. `re` and `im` must have the same power-of-two length. */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`FFT length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const evenRe = re[i + k] as number;
        const evenIm = im[i + k] as number;
        const oddRe = re[i + k + len / 2] as number;
        const oddIm = im[i + k + len / 2] as number;
        const tRe = oddRe * curRe - oddIm * curIm;
        const tIm = oddRe * curIm + oddIm * curRe;
        re[i + k] = evenRe + tRe;
        im[i + k] = evenIm + tIm;
        re[i + k + len / 2] = evenRe - tRe;
        im[i + k + len / 2] = evenIm - tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Periodic Hann window, cached per size because frames are all the same length. */
const hannCache = new Map<number, Float32Array>();

export function hannWindow(size: number): Float32Array {
  const cached = hannCache.get(size);
  if (cached) return cached;
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  hannCache.set(size, window);
  return window;
}

/** Magnitude spectrum of one windowed frame. Returns `size / 2 + 1` bins. */
export function magnitudeSpectrum(frame: Float32Array): Float32Array {
  const size = frame.length;
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const window = hannWindow(size);
  for (let i = 0; i < size; i += 1) re[i] = (frame[i] as number) * (window[i] as number);
  fftInPlace(re, im);

  const bins = size / 2 + 1;
  const magnitude = new Float32Array(bins);
  for (let i = 0; i < bins; i += 1) {
    const r = re[i] as number;
    const m = im[i] as number;
    magnitude[i] = Math.sqrt(r * r + m * m);
  }
  return magnitude;
}

/** Energy-weighted mean frequency of a magnitude spectrum, in Hz. */
export function spectralCentroid(magnitude: Float32Array, sampleRate: number): number {
  const binHz = sampleRate / 2 / (magnitude.length - 1);
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < magnitude.length; i += 1) {
    const m = magnitude[i] as number;
    weighted += m * i * binHz;
    total += m;
  }
  return total === 0 ? 0 : weighted / total;
}

/** Share of spectral energy inside a frequency band, 0..1. */
export function bandEnergyRatio(
  magnitude: Float32Array,
  sampleRate: number,
  lowHz: number,
  highHz: number,
): number {
  const binHz = sampleRate / 2 / (magnitude.length - 1);
  let band = 0;
  let total = 0;
  for (let i = 0; i < magnitude.length; i += 1) {
    const energy = (magnitude[i] as number) ** 2;
    const hz = i * binHz;
    if (hz >= lowHz && hz < highHz) band += energy;
    total += energy;
  }
  return total === 0 ? 0 : band / total;
}

/** Zero-crossing rate over a slice, 0..1. Cheap proxy for noisiness. */
export function zeroCrossingRate(samples: Float32Array, from: number, to: number): number {
  const end = Math.min(to, samples.length);
  if (end - from < 2) return 0;
  let crossings = 0;
  for (let i = from + 1; i < end; i += 1) {
    const previous = samples[i - 1] as number;
    const current = samples[i] as number;
    if ((previous >= 0 && current < 0) || (previous < 0 && current >= 0)) crossings += 1;
  }
  return crossings / (end - from - 1);
}

/** Root-mean-square over a slice. */
export function rmsOf(samples: Float32Array, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(to, samples.length);
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) {
    const value = samples[i] as number;
    sum += value * value;
  }
  return Math.sqrt(sum / (end - start));
}

/** Median of a numeric array. Used for the adaptive onset threshold. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
