/**
 * US-0301 - one internal audio representation.
 *
 * Browsers hand back wildly different containers from `MediaRecorder`: WebM/Opus
 * on Chrome and Firefox, MP4/AAC on Safari, sometimes at 48 kHz and sometimes at
 * whatever the device felt like. Nothing downstream should have to care. Every
 * path - microphone capture, file upload, a test fixture - converts to
 * `MonoAudio` here first, and the model and the DSP only ever see that.
 */

import type { AudioDiagnostics, AudioValidation, AudioValidationCode, MonoAudio } from '@contracts';

/** The subset of `AudioBuffer` this package needs, so Node tests need no DOM. */
export interface AudioBufferLike {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Deterministic downmix: the unweighted mean of every channel.
 *
 * Deliberately not "take the left channel" - a user holding a laptop off-axis
 * can land almost all of their voice in one side, and dropping the other half
 * would quietly halve the level for some people and not others.
 */
export function toMonoAudio(buffer: AudioBufferLike): MonoAudio {
  const { numberOfChannels, sampleRate, length } = buffer;
  const samples = new Float32Array(length);

  if (numberOfChannels === 1) {
    samples.set(buffer.getChannelData(0));
  } else {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        samples[i] = (samples[i] as number) + (data[i] as number);
      }
    }
    for (let i = 0; i < length; i += 1) {
      samples[i] = (samples[i] as number) / numberOfChannels;
    }
  }

  return { samples, sampleRate, durationSec: length / sampleRate };
}

/** Sample magnitude counted as clipped. Just below 1 to catch codec rounding. */
const CLIP_LEVEL = 0.985;
/** Frame RMS below this is treated as room tone rather than voice. */
const SILENCE_FLOOR_RMS = 0.004;
/** Analysis frame length. 20 ms is short enough to see a gap between phrases. */
const FRAME_MS = 20;

export function analyzeAudio(audio: MonoAudio): AudioDiagnostics {
  const { samples, sampleRate, durationSec } = audio;
  const frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] as number;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= CLIP_LEVEL) clipped += 1;
    sumSquares += value * value;
  }

  let frames = 0;
  let silentFrames = 0;
  let loudestFrameRms = 0;

  for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
    let frameSum = 0;
    for (let i = start; i < start + frameSize; i += 1) {
      const value = samples[i] as number;
      frameSum += value * value;
    }
    const frameRms = Math.sqrt(frameSum / frameSize);
    if (frameRms > loudestFrameRms) loudestFrameRms = frameRms;
    if (frameRms < SILENCE_FLOOR_RMS) silentFrames += 1;
    frames += 1;
  }

  return {
    durationSec,
    sampleRate,
    peak,
    rms: samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0,
    clippedRatio: samples.length > 0 ? clipped / samples.length : 0,
    silentRatio: frames > 0 ? silentFrames / frames : 1,
    loudestFrameRms,
  };
}

export interface ValidationThresholds {
  minDurationSec: number;
  /** Loudest 20 ms frame below this means nothing was captured at all. */
  emptyFrameRms: number;
  /** Loudest frame below this is faint; combined with silentRatio it warns. */
  faintFrameRms: number;
  /** Fraction of frames that must be silent before "mostly silent" applies. */
  mostlySilentRatio: number;
  /** Fraction of clipped samples that counts as real distortion, not a stray peak. */
  clippedRatio: number;
}

/**
 * US-0208 - calibrated, not a single arbitrary gate.
 *
 * The failure mode this guards against is rejecting a soft singer. A quiet take
 * is still a take, so quietness alone never blocks processing; only a clip whose
 * *loudest* 20 ms frame sits at the noise floor is genuinely empty. Likewise a
 * couple of clipped samples on a plosive is normal - distortion is only reported
 * once it covers a meaningful share of the recording.
 *
 * Values are engineering defaults, listed in one place so a corpus run can move
 * them without hunting through the UI. Rationale is in
 * `docs/benchmarks/audio-validation-thresholds.md`.
 */
export const DEFAULT_VALIDATION_THRESHOLDS: ValidationThresholds = {
  minDurationSec: 0.75,
  emptyFrameRms: 0.0025,
  faintFrameRms: 0.012,
  mostlySilentRatio: 0.97,
  clippedRatio: 0.02,
};

export function validateAudio(
  audio: MonoAudio,
  thresholds: ValidationThresholds = DEFAULT_VALIDATION_THRESHOLDS,
): AudioValidation {
  const diagnostics = analyzeAudio(audio);

  const decide = (): { code: AudioValidationCode; usable: boolean } => {
    if (diagnostics.durationSec < thresholds.minDurationSec) {
      return { code: 'too_short', usable: false };
    }
    if (diagnostics.loudestFrameRms < thresholds.emptyFrameRms) {
      return { code: 'silent', usable: false };
    }
    if (
      diagnostics.loudestFrameRms < thresholds.faintFrameRms &&
      diagnostics.silentRatio > thresholds.mostlySilentRatio
    ) {
      // Usable: faint material still transcribes, the user just gets a nudge.
      return { code: 'mostly_silent', usable: true };
    }
    if (diagnostics.clippedRatio > thresholds.clippedRatio) {
      return { code: 'clipped', usable: true };
    }
    return { code: 'ok', usable: true };
  };

  return { ...decide(), diagnostics };
}

/**
 * Scales the clip so its peak sits at `target`, leaving headroom.
 * Applied before inference only - never to what the user hears back, because
 * changing the level of their own take is disorienting.
 */
export function peakNormalize(audio: MonoAudio, target = 0.89): MonoAudio {
  const { peak } = analyzeAudio(audio);
  if (peak === 0 || Math.abs(peak - target) < 0.01) return audio;
  const gain = target / peak;
  const samples = new Float32Array(audio.samples.length);
  for (let i = 0; i < samples.length; i += 1) samples[i] = (audio.samples[i] as number) * gain;
  return { ...audio, samples };
}

/**
 * Linear resampling to a target rate.
 *
 * Basic Pitch runs at 22.05 kHz internally, and the recorded rate is whatever
 * the device chose, so a resample is unavoidable somewhere. Doing it here keeps
 * it visible and testable instead of hidden inside the model wrapper.
 */
export function resample(audio: MonoAudio, targetSampleRate: number): MonoAudio {
  if (audio.sampleRate === targetSampleRate) return audio;
  const ratio = targetSampleRate / audio.sampleRate;
  const length = Math.max(1, Math.round(audio.samples.length * ratio));
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const source = i / ratio;
    const index = Math.floor(source);
    const frac = source - index;
    const a = audio.samples[Math.min(index, audio.samples.length - 1)] as number;
    const b = audio.samples[Math.min(index + 1, audio.samples.length - 1)] as number;
    samples[i] = a + (b - a) * frac;
  }
  return { samples, sampleRate: targetSampleRate, durationSec: length / targetSampleRate };
}

/** Trims leading and trailing room tone, keeping a short musical pre-roll. */
export function trimSilence(audio: MonoAudio, padSec = 0.05): MonoAudio {
  const frameSize = Math.max(1, Math.round((audio.sampleRate * FRAME_MS) / 1000));
  const isVoiced = (start: number): boolean => {
    let sum = 0;
    const end = Math.min(start + frameSize, audio.samples.length);
    for (let i = start; i < end; i += 1) {
      const value = audio.samples[i] as number;
      sum += value * value;
    }
    return Math.sqrt(sum / Math.max(1, end - start)) >= SILENCE_FLOOR_RMS;
  };

  let first = 0;
  while (first + frameSize <= audio.samples.length && !isVoiced(first)) first += frameSize;
  let last = audio.samples.length - frameSize;
  while (last > first && !isVoiced(last)) last -= frameSize;
  if (first >= last) return audio;

  const pad = Math.round(padSec * audio.sampleRate);
  const from = Math.max(0, first - pad);
  const to = Math.min(audio.samples.length, last + frameSize + pad);
  const samples = audio.samples.slice(from, to);
  return { samples, sampleRate: audio.sampleRate, durationSec: samples.length / audio.sampleRate };
}
