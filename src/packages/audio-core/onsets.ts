/**
 * US-0502 - rhythmic onset detection.
 *
 * Rhythm is a separate algorithmic path, not melody transcription with the
 * pitch thrown away (Playbook 8.4). A beatbox take has no fundamental worth
 * tracking; what matters is where the attacks are and what they sound like.
 *
 * Method: half-wave-rectified spectral flux, normalised, then peak-picked
 * against an adaptive median threshold. Standard, cheap, and it does not need a
 * trained model - which matters because a model would need a licensed,
 * documented training corpus the product does not have (US-0503).
 */

import type { OnsetEvent, OnsetFeatures } from '@contracts';
import {
  bandEnergyRatio,
  magnitudeSpectrum,
  median,
  rmsOf,
  spectralCentroid,
  zeroCrossingRate,
} from './fft';

export interface OnsetOptions {
  frameSize: number;
  hopSize: number;
  /** How far above the local median flux a peak must rise, in median units. */
  thresholdRatio: number;
  /** Absolute floor so a silent passage cannot produce onsets from noise. */
  thresholdFloor: number;
  /** Frames either side used for the adaptive median. */
  medianWindowFrames: number;
  /** Minimum gap between accepted onsets. Guards against double triggers. */
  minGapSec: number;
}

export const DEFAULT_ONSET_OPTIONS: OnsetOptions = {
  frameSize: 1024,
  hopSize: 256,
  thresholdRatio: 1.6,
  thresholdFloor: 0.06,
  medianWindowFrames: 12,
  // 55 ms. Faster than any beatbox stroke a person can articulate cleanly, so
  // anything closer than this is the decay of the previous hit, not a new one.
  minGapSec: 0.055,
};

export interface OnsetDetectionResult {
  onsets: OnsetEvent[];
  /** The normalised detection function, kept for tests and diagnostics. */
  flux: Float32Array;
  fluxHopSec: number;
}

export function detectOnsets(
  samples: Float32Array,
  sampleRate: number,
  options: OnsetOptions = DEFAULT_ONSET_OPTIONS,
): OnsetDetectionResult {
  const { frameSize, hopSize } = options;
  const fluxHopSec = hopSize / sampleRate;
  const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  if (frameCount < 3) {
    return { onsets: [], flux: new Float32Array(0), fluxHopSec };
  }

  const spectra: Float32Array[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const start = i * hopSize;
    spectra.push(magnitudeSpectrum(samples.slice(start, start + frameSize)));
  }

  // Half-wave-rectified spectral flux: only energy *appearing* counts.
  const flux = new Float32Array(frameCount);
  for (let i = 1; i < frameCount; i += 1) {
    const current = spectra[i] as Float32Array;
    const previous = spectra[i - 1] as Float32Array;
    let sum = 0;
    for (let bin = 0; bin < current.length; bin += 1) {
      const delta = (current[bin] as number) - (previous[bin] as number);
      if (delta > 0) sum += delta;
    }
    flux[i] = sum;
  }

  let peak = 0;
  for (let i = 0; i < frameCount; i += 1) peak = Math.max(peak, flux[i] as number);
  if (peak > 0) for (let i = 0; i < frameCount; i += 1) flux[i] = (flux[i] as number) / peak;

  const half = options.medianWindowFrames >> 1;
  const accepted: OnsetEvent[] = [];
  let lastAcceptedSec = Number.NEGATIVE_INFINITY;

  for (let i = 1; i < frameCount - 1; i += 1) {
    const value = flux[i] as number;
    // Local maximum only, so the rising edge of a hit produces one event.
    if (value <= (flux[i - 1] as number) || value < (flux[i + 1] as number)) continue;

    const window: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(frameCount - 1, i + half); j += 1) {
      window.push(flux[j] as number);
    }
    const threshold = Math.max(
      options.thresholdFloor,
      median(window) * options.thresholdRatio + 0.02,
    );
    if (value < threshold) continue;

    const timeSec = i * fluxHopSec;
    if (timeSec - lastAcceptedSec < options.minGapSec) {
      // Within the guard window: keep whichever hit is stronger rather than
      // always keeping the first, so a soft pre-echo cannot mask the real one.
      const previous = accepted[accepted.length - 1];
      if (previous && value > previous.strength) {
        accepted[accepted.length - 1] = {
          timeSec,
          strength: value,
          features: extractFeatures(samples, sampleRate, timeSec, options),
        };
        lastAcceptedSec = timeSec;
      }
      continue;
    }

    accepted.push({
      timeSec,
      strength: value,
      features: extractFeatures(samples, sampleRate, timeSec, options),
    });
    lastAcceptedSec = timeSec;
  }

  return { onsets: accepted, flux, fluxHopSec };
}

/** Attack window used for classification features. 40 ms after the onset. */
const ATTACK_WINDOW_SEC = 0.04;
/** Window used to measure how fast the hit dies away. */
const DECAY_WINDOW_SEC = 0.2;

export function extractFeatures(
  samples: Float32Array,
  sampleRate: number,
  timeSec: number,
  options: OnsetOptions = DEFAULT_ONSET_OPTIONS,
): OnsetFeatures {
  const start = Math.max(0, Math.round(timeSec * sampleRate));
  const attackEnd = Math.min(samples.length, start + Math.round(ATTACK_WINDOW_SEC * sampleRate));

  const frame = new Float32Array(options.frameSize);
  frame.set(samples.subarray(start, Math.min(samples.length, start + options.frameSize)));
  const magnitude = magnitudeSpectrum(frame);

  const peak = rmsOf(samples, start, attackEnd);
  const decayEnd = Math.min(samples.length, start + Math.round(DECAY_WINDOW_SEC * sampleRate));
  const tailRms = rmsOf(samples, attackEnd, decayEnd);
  // Time for the tail to fall to 1/e of the attack, estimated from two windows.
  const decaySec =
    peak > 0 && tailRms > 0 && tailRms < peak
      ? Math.min(DECAY_WINDOW_SEC, ATTACK_WINDOW_SEC / Math.log(peak / tailRms))
      : DECAY_WINDOW_SEC;

  return {
    centroidHz: spectralCentroid(magnitude, sampleRate),
    lowRatio: bandEnergyRatio(magnitude, sampleRate, 0, 250),
    highRatio: bandEnergyRatio(magnitude, sampleRate, 4000, sampleRate / 2),
    zeroCrossingRate: zeroCrossingRate(samples, start, attackEnd),
    peak: Math.min(1, peak),
    decaySec,
  };
}
