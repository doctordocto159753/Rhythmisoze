/** Monophonic fundamental-frequency tracking for human voice. */

export interface PitchFrame {
  timeSec: number;
  frequencyHz: number | null;
  midiPitch: number | null;
  confidence: number;
  /** Frame energy after preprocessing, used for velocity and quality scoring. */
  rms: number;
}

export interface PitchTrackerOptions {
  targetSampleRate: number;
  frameSize: number;
  hopSize: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
  yinThreshold: number;
  minConfidence: number;
}

export const DEFAULT_PITCH_TRACKER_OPTIONS: PitchTrackerOptions = {
  targetSampleRate: 16_000,
  frameSize: 1024,
  hopSize: 160,
  minFrequencyHz: 70,
  maxFrequencyHz: 1000,
  yinThreshold: 0.16,
  minConfidence: 0.68,
};

export interface PreparedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Makes recordings from microphones/codecs comparable without changing pitch:
 * mono input is resampled, DC is removed, and peak gain is bounded.
 */
export function prepareVoiceAudio(
  samples: Float32Array,
  sampleRate: number,
  targetSampleRate = DEFAULT_PITCH_TRACKER_OPTIONS.targetSampleRate,
): PreparedAudio {
  const resampled = sampleRate === targetSampleRate
    ? new Float32Array(samples)
    : linearResample(samples, sampleRate, targetSampleRate);
  const filtered = new Float32Array(resampled.length);
  let previousInput = 0;
  let previousOutput = 0;
  let peak = 0;
  for (let index = 0; index < resampled.length; index += 1) {
    const input = resampled[index] ?? 0;
    // One-pole DC blocker. Its corner is low enough to leave vocal fundamentals intact.
    const output = input - previousInput + 0.995 * previousOutput;
    filtered[index] = output;
    previousInput = input;
    previousOutput = output;
    peak = Math.max(peak, Math.abs(output));
  }
  const gain = peak > 1e-5 ? Math.min(8, 0.92 / peak) : 1;
  if (Math.abs(gain - 1) > 1e-6) {
    for (let index = 0; index < filtered.length; index += 1) {
      filtered[index] = (filtered[index] ?? 0) * gain;
    }
  }
  return { samples: filtered, sampleRate: targetSampleRate };
}

/** Runs YIN and marks silence/unreliable frames explicitly with null pitch. */
export function trackFundamentalPitch(
  samples: Float32Array,
  sampleRate: number,
  overrides: Partial<PitchTrackerOptions> = {},
): PitchFrame[] {
  const options = { ...DEFAULT_PITCH_TRACKER_OPTIONS, ...overrides };
  const prepared = prepareVoiceAudio(samples, sampleRate, options.targetSampleRate);
  const provisional: Array<{
    timeSec: number;
    frequencyHz: number;
    clarity: number;
    rms: number;
  }> = [];

  for (
    let start = 0;
    start + options.frameSize <= prepared.samples.length;
    start += options.hopSize
  ) {
    const frame = prepared.samples.subarray(start, start + options.frameSize);
    const rms = rootMeanSquare(frame);
    const estimate = yin(frame, prepared.sampleRate, options);
    provisional.push({
      timeSec: start / prepared.sampleRate,
      frequencyHz: estimate.frequencyHz,
      clarity: estimate.clarity,
      rms,
    });
  }

  const energies = provisional.map((frame) => frame.rms).sort((a, b) => a - b);
  const noiseFloor = percentile(energies, 0.2);
  const strongLevel = percentile(energies, 0.9);
  const energyGate = Math.max(0.003, Math.min(strongLevel * 0.18, noiseFloor * 2.8 + 0.0015));
  const usefulSpan = Math.max(0.004, strongLevel - energyGate);

  return provisional.map((frame) => {
    const energyConfidence = clamp01((frame.rms - energyGate) / usefulSpan);
    const confidence = clamp01(frame.clarity * (0.55 + 0.45 * energyConfidence));
    const voiced =
      frame.frequencyHz >= options.minFrequencyHz &&
      frame.frequencyHz <= options.maxFrequencyHz &&
      frame.rms >= energyGate &&
      confidence >= options.minConfidence;
    return {
      timeSec: frame.timeSec,
      frequencyHz: voiced ? frame.frequencyHz : null,
      midiPitch: voiced ? frequencyToMidi(frame.frequencyHz) : null,
      confidence,
      rms: frame.rms,
    };
  });
}

export function frequencyToMidi(frequencyHz: number): number {
  return 69 + 12 * Math.log2(frequencyHz / 440);
}

export function midiToFrequency(midiPitch: number): number {
  return 440 * 2 ** ((midiPitch - 69) / 12);
}

function yin(
  frame: Float32Array,
  sampleRate: number,
  options: PitchTrackerOptions,
): { frequencyHz: number; clarity: number } {
  const analysisSize = frame.length >> 1;
  const minTau = Math.max(2, Math.floor(sampleRate / options.maxFrequencyHz));
  const maxTau = Math.min(analysisSize - 1, Math.ceil(sampleRate / options.minFrequencyHz));
  if (maxTau <= minTau) return { frequencyHz: 0, clarity: 0 };

  const difference = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0;
    for (let index = 0; index < analysisSize; index += 1) {
      const delta = (frame[index] ?? 0) - (frame[index + tau] ?? 0);
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  const normalized = new Float32Array(maxTau + 1);
  normalized[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    running += difference[tau] ?? 0;
    normalized[tau] = running > 0 ? ((difference[tau] ?? 0) * tau) / running : 1;
  }

  let chosen = -1;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if ((normalized[tau] ?? 1) < options.yinThreshold) {
      chosen = tau;
      while (
        chosen < maxTau &&
        (normalized[chosen + 1] ?? 1) < (normalized[chosen] ?? 1)
      ) {
        chosen += 1;
      }
      break;
    }
  }
  if (chosen < 0) {
    chosen = minTau;
    for (let tau = minTau + 1; tau <= maxTau; tau += 1) {
      if ((normalized[tau] ?? 1) < (normalized[chosen] ?? 1)) chosen = tau;
    }
  }

  let refinedTau = chosen;
  if (chosen > minTau && chosen < maxTau) {
    const left = normalized[chosen - 1] ?? 1;
    const center = normalized[chosen] ?? 1;
    const right = normalized[chosen + 1] ?? 1;
    const denominator = 2 * (2 * center - left - right);
    if (Math.abs(denominator) > 1e-9) refinedTau += (right - left) / denominator;
  }
  return {
    frequencyHz: refinedTau > 0 ? sampleRate / refinedTau : 0,
    clarity: clamp01(1 - (normalized[chosen] ?? 1)),
  };
}

function linearResample(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (input.length === 0 || inputRate <= 0 || outputRate <= 0) return new Float32Array();
  const length = Math.max(1, Math.round((input.length * outputRate) / inputRate));
  const output = new Float32Array(length);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

function rootMeanSquare(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = clamp01(fraction) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const mix = position - low;
  return (sorted[low] ?? 0) * (1 - mix) + (sorted[high] ?? 0) * mix;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
