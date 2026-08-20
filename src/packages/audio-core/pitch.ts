/**
 * Monophonic pitch tracking (YIN) and note segmentation.
 *
 * This is the `pitch-tracker` transcription backend. It is *not* a stand-in for
 * Basic Pitch and it is not presented to the user as one: Basic Pitch is the
 * primary path (PRD T-01), this runs when the model cannot be reached - an
 * offline first visit, a blocked CDN, a device that will not initialise the
 * WebGL backend - and the UI names which one produced the result.
 *
 * It earns its place for a second reason: it is a real algorithm that runs in
 * Node, so the retouch pipeline can be tested end to end against synthesised
 * audio without a 20 MB model in CI.
 *
 * Reference: de Cheveigne and Kawahara, "YIN, a fundamental frequency estimator
 * for speech and music", JASA 111(4), 2002.
 */

import type { NoteEvent } from '@contracts';
import { rmsOf } from './fft';

export interface PitchFrame {
  timeSec: number;
  /** Fundamental in Hz, or 0 when the frame is unvoiced. */
  frequencyHz: number;
  /** 1 - aperiodicity, 0..1. */
  clarity: number;
  rms: number;
}

export interface YinOptions {
  frameSize: number;
  hopSize: number;
  /** YIN absolute threshold. Lower is stricter about periodicity. */
  threshold: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
}

export const DEFAULT_YIN_OPTIONS: YinOptions = {
  // 2048 samples covers two periods of a low male hum at 44.1 kHz.
  frameSize: 2048,
  hopSize: 256,
  threshold: 0.15,
  minFrequencyHz: 65,
  maxFrequencyHz: 1200,
};

/** Estimates the fundamental of a single frame. Returns 0 Hz when unvoiced. */
export function yinFrame(
  frame: Float32Array,
  sampleRate: number,
  options: YinOptions,
): { frequencyHz: number; clarity: number } {
  const size = frame.length;
  const halfSize = size >> 1;
  const minTau = Math.max(2, Math.floor(sampleRate / options.maxFrequencyHz));
  const maxTau = Math.min(halfSize - 1, Math.ceil(sampleRate / options.minFrequencyHz));
  if (maxTau <= minTau) return { frequencyHz: 0, clarity: 0 };

  // Step 1: squared difference function.
  const diff = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0;
    for (let i = 0; i < halfSize; i += 1) {
      const delta = (frame[i] as number) - (frame[i + tau] as number);
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Step 2: cumulative mean normalized difference.
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    runningSum += diff[tau] as number;
    cmnd[tau] = runningSum === 0 ? 1 : ((diff[tau] as number) * tau) / runningSum;
  }

  // Step 3: first dip below the absolute threshold, then walk to its bottom.
  let chosen = -1;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if ((cmnd[tau] as number) < options.threshold) {
      let best = tau;
      while (best + 1 <= maxTau && (cmnd[best + 1] as number) < (cmnd[best] as number)) best += 1;
      chosen = best;
      break;
    }
  }
  // No dip: fall back to the global minimum so a marginal frame still reports
  // a clarity the segmenter can reject, rather than vanishing silently.
  if (chosen === -1) {
    let best = minTau;
    for (let tau = minTau; tau <= maxTau; tau += 1) {
      if ((cmnd[tau] as number) < (cmnd[best] as number)) best = tau;
    }
    chosen = best;
  }

  // Step 4: parabolic interpolation for sub-sample period resolution.
  let refined = chosen;
  if (chosen > minTau && chosen < maxTau) {
    const a = cmnd[chosen - 1] as number;
    const b = cmnd[chosen] as number;
    const c = cmnd[chosen + 1] as number;
    const denominator = 2 * (2 * b - a - c);
    if (denominator !== 0) refined = chosen + (c - a) / denominator;
  }

  const clarity = Math.max(0, Math.min(1, 1 - (cmnd[chosen] as number)));
  return { frequencyHz: refined > 0 ? sampleRate / refined : 0, clarity };
}

/** Runs YIN across the whole clip. */
export function trackPitch(
  samples: Float32Array,
  sampleRate: number,
  options: YinOptions = DEFAULT_YIN_OPTIONS,
): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const { frameSize, hopSize } = options;
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const frame = samples.subarray(start, start + frameSize);
    const { frequencyHz, clarity } = yinFrame(frame, sampleRate, options);
    frames.push({
      timeSec: start / sampleRate,
      frequencyHz,
      clarity,
      rms: rmsOf(samples, start, start + frameSize),
    });
  }
  return frames;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export interface SegmentOptions {
  /** Frames below this clarity are treated as unvoiced. */
  minClarity: number;
  /** Frames below this RMS are treated as unvoiced regardless of clarity. */
  minRms: number;
  /** How far a frame may drift from the note's running pitch before it splits. */
  maxDriftSemitones: number;
  /** Unvoiced frames tolerated inside a note before it ends. */
  maxGapFrames: number;
  /** Notes shorter than this never reach the retouch stage. */
  minDurationSec: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  minClarity: 0.72,
  minRms: 0.006,
  maxDriftSemitones: 0.9,
  maxGapFrames: 3,
  minDurationSec: 0.06,
};

/**
 * Turns per-frame pitch into notes.
 *
 * A 5-frame median filter runs first. Hummed vowels produce single-frame octave
 * flips at phrase boundaries, and a median filter removes them at the point
 * where they are cheapest to remove - before they become a note that the octave
 * filter then has to argue with.
 */
export function segmentNotes(
  frames: readonly PitchFrame[],
  options: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
  frameHopSec = DEFAULT_YIN_OPTIONS.hopSize / 44100,
): NoteEvent[] {
  const midi = frames.map((f) =>
    f.frequencyHz > 0 && f.clarity >= options.minClarity && f.rms >= options.minRms
      ? hzToMidi(f.frequencyHz)
      : Number.NaN,
  );
  const smoothed = medianFilter(midi, 5);

  const notes: NoteEvent[] = [];
  let current: { values: number[]; rms: number[]; startIndex: number; lastVoiced: number } | null =
    null;

  const close = (endIndex: number): void => {
    if (!current) return;
    const startSec = (frames[current.startIndex] as PitchFrame).timeSec;
    const endSec = (frames[Math.min(endIndex, frames.length - 1)] as PitchFrame).timeSec + frameHopSec;
    const pitch = Math.round(medianOf(current.values));
    const peakRms = Math.max(...current.rms);
    if (endSec - startSec >= options.minDurationSec && Number.isFinite(pitch)) {
      notes.push({
        startSec,
        endSec,
        pitch: Math.max(0, Math.min(127, pitch)),
        velocity: rmsToVelocity(peakRms),
        confidence: Math.min(1, medianOf(current.rms.map(() => 1))),
      });
    }
    current = null;
  };

  for (let i = 0; i < smoothed.length; i += 1) {
    const value = smoothed[i] as number;
    const voiced = Number.isFinite(value);

    if (!voiced) {
      if (current && i - current.lastVoiced > options.maxGapFrames) close(current.lastVoiced);
      continue;
    }

    if (!current) {
      current = { values: [value], rms: [(frames[i] as PitchFrame).rms], startIndex: i, lastVoiced: i };
      continue;
    }

    const reference = medianOf(current.values);
    if (Math.abs(value - reference) > options.maxDriftSemitones) {
      close(current.lastVoiced);
      current = { values: [value], rms: [(frames[i] as PitchFrame).rms], startIndex: i, lastVoiced: i };
      continue;
    }

    current.values.push(value);
    current.rms.push((frames[i] as PitchFrame).rms);
    current.lastVoiced = i;
  }
  if (current) close((current as { lastVoiced: number }).lastVoiced);

  return notes;
}

/** Maps peak RMS to MIDI velocity on a perceptual (dB) curve, floored at 25. */
export function rmsToVelocity(rms: number): number {
  if (rms <= 0) return 25;
  const db = 20 * Math.log10(rms);
  // -48 dBFS -> 25, -6 dBFS -> 118. Linear in dB, which is how loudness reads.
  const scaled = ((db + 48) / 42) * 93 + 25;
  return Math.max(25, Math.min(127, Math.round(scaled)));
}

function medianFilter(values: readonly number[], window: number): number[] {
  const half = window >> 1;
  return values.map((_, i) => {
    const slice: number[] = [];
    for (let j = i - half; j <= i + half; j += 1) {
      const value = values[j];
      if (value !== undefined && Number.isFinite(value)) slice.push(value);
    }
    // Fewer than half the window voiced means this really is a gap.
    if (slice.length <= half) return Number.NaN;
    return medianOf(slice);
  });
}

function medianOf(values: readonly number[]): number {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return Number.NaN;
  const mid = finite.length >> 1;
  return finite.length % 2 === 1
    ? (finite[mid] as number)
    : ((finite[mid - 1] as number) + (finite[mid] as number)) / 2;
}
