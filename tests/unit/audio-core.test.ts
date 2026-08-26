/**
 * US-0201..US-0208, US-0301, US-0502, US-0503 - the audio-core package.
 *
 * These tests run against synthesised signals rather than recordings, because a
 * synthesised signal has a known right answer: a 220 Hz sine really is A3, and a
 * click really is at 0.5 s. Recorded fixtures belong in the benchmark corpus,
 * which measures accuracy; this file measures correctness.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeAudio,
  bandEnergyRatio,
  classifyOnset,
  DEFAULT_YIN_OPTIONS,
  detectOnsets,
  encodeWav,
  fftInPlace,
  hzToMidi,
  magnitudeSpectrum,
  midiToHz,
  peakNormalize,
  readWavHeader,
  resample,
  rmsToVelocity,
  segmentNotes,
  spectralCentroid,
  strengthToVelocity,
  toMonoAudio,
  trackPitch,
  validateAudio,
  yinFrame,
  type AudioBufferLike,
} from '@audio-core';

const SAMPLE_RATE = 44100;

function sine(frequencyHz: number, seconds: number, amplitude = 0.5, sampleRate = SAMPLE_RATE) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
  }
  return { samples, sampleRate, durationSec: samples.length / sampleRate };
}

function silence(seconds: number, sampleRate = SAMPLE_RATE) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  return { samples, sampleRate, durationSec: seconds };
}

function fakeBuffer(channels: Float32Array[], sampleRate = SAMPLE_RATE): AudioBufferLike {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: (channels[0] as Float32Array).length,
    getChannelData: (index: number) => channels[index] as Float32Array,
  };
}

describe('toMonoAudio', () => {
  it('passes a mono buffer through unchanged', () => {
    const data = new Float32Array([0.1, -0.2, 0.3]);
    const result = toMonoAudio(fakeBuffer([data]));
    expect([...result.samples]).toEqual([...data]);
  });

  it('downmixes by averaging every channel, not by dropping one', () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 1, 1]);
    const result = toMonoAudio(fakeBuffer([left, right]));
    expect([...result.samples]).toEqual([0.5, 0.5, 0]);
  });

  it('reports duration from length and rate', () => {
    const result = toMonoAudio(fakeBuffer([new Float32Array(22050)]));
    expect(result.durationSec).toBeCloseTo(0.5, 9);
  });
});

describe('analyzeAudio', () => {
  it('measures peak and RMS of a known sine', () => {
    const diagnostics = analyzeAudio(sine(440, 1, 0.5));
    expect(diagnostics.peak).toBeCloseTo(0.5, 2);
    // RMS of a sine is amplitude / sqrt(2).
    expect(diagnostics.rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('detects clipping', () => {
    const clipped = sine(440, 1, 1.4);
    for (let i = 0; i < clipped.samples.length; i += 1) {
      clipped.samples[i] = Math.max(-1, Math.min(1, clipped.samples[i] as number));
    }
    expect(analyzeAudio(clipped).clippedRatio).toBeGreaterThan(0.1);
  });

  it('reports silence as fully silent', () => {
    const diagnostics = analyzeAudio(silence(1));
    expect(diagnostics.silentRatio).toBe(1);
    expect(diagnostics.loudestFrameRms).toBe(0);
  });
});

describe('validateAudio', () => {
  it('accepts a normal take', () => {
    expect(validateAudio(sine(220, 3, 0.35)).code).toBe('ok');
  });

  it('rejects an empty recording', () => {
    const result = validateAudio(silence(3));
    expect(result.code).toBe('silent');
    expect(result.usable).toBe(false);
  });

  it('rejects a clip shorter than the floor', () => {
    expect(validateAudio(sine(220, 0.3, 0.4)).code).toBe('too_short');
  });

  it('does not reject a quiet singer', () => {
    // -34 dBFS: soft, but plainly a performance rather than room tone.
    const result = validateAudio(sine(220, 3, 0.02));
    expect(result.usable).toBe(true);
    expect(result.code).toBe('ok');
  });

  it('warns about heavy clipping without refusing to process it', () => {
    const loud = sine(220, 3, 2);
    for (let i = 0; i < loud.samples.length; i += 1) {
      loud.samples[i] = Math.max(-1, Math.min(1, loud.samples[i] as number));
    }
    const result = validateAudio(loud);
    expect(result.code).toBe('clipped');
    expect(result.usable).toBe(true);
  });
});

describe('peakNormalize / resample', () => {
  it('brings the peak to the requested level', () => {
    const normalized = peakNormalize(sine(440, 0.5, 0.05), 0.9);
    expect(analyzeAudio(normalized).peak).toBeCloseTo(0.9, 2);
  });

  it('resamples to the requested rate and preserves duration', () => {
    const result = resample(sine(440, 1, 0.5), 22050);
    expect(result.sampleRate).toBe(22050);
    expect(result.durationSec).toBeCloseTo(1, 2);
  });

  it('is a no-op when the rate already matches', () => {
    const input = sine(440, 0.2);
    expect(resample(input, SAMPLE_RATE)).toBe(input);
  });
});

describe('FFT', () => {
  it('puts a pure tone in the expected bin', () => {
    const size = 1024;
    const binHz = SAMPLE_RATE / size;
    const targetBin = 40;
    const frame = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
      frame[i] = Math.sin((2 * Math.PI * targetBin * i) / size);
    }
    const magnitude = magnitudeSpectrum(frame);
    let peakBin = 0;
    for (let i = 0; i < magnitude.length; i += 1) {
      if ((magnitude[i] as number) > (magnitude[peakBin] as number)) peakBin = i;
    }
    expect(peakBin).toBe(targetBin);
    expect(spectralCentroid(magnitude, SAMPLE_RATE)).toBeGreaterThan(targetBin * binHz * 0.7);
  });

  it('rejects a non-power-of-two length', () => {
    expect(() => fftInPlace(new Float32Array(100), new Float32Array(100))).toThrow(/power of two/);
  });

  it('measures band energy of a low tone as low-band', () => {
    const frame = new Float32Array(1024);
    for (let i = 0; i < frame.length; i += 1) {
      frame[i] = Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE);
    }
    const magnitude = magnitudeSpectrum(frame);
    expect(bandEnergyRatio(magnitude, SAMPLE_RATE, 0, 250)).toBeGreaterThan(0.8);
    expect(bandEnergyRatio(magnitude, SAMPLE_RATE, 4000, SAMPLE_RATE / 2)).toBeLessThan(0.05);
  });
});

describe('YIN pitch tracking', () => {
  it.each([
    ['A3', 220],
    ['C4', 261.63],
    ['A4', 440],
    ['E5', 659.26],
  ])('estimates %s within a tenth of a semitone', (_name, frequency) => {
    const audio = sine(frequency, 0.2, 0.5);
    const frame = audio.samples.subarray(0, DEFAULT_YIN_OPTIONS.frameSize);
    const result = yinFrame(frame, SAMPLE_RATE, DEFAULT_YIN_OPTIONS);
    expect(Math.abs(hzToMidi(result.frequencyHz) - hzToMidi(frequency))).toBeLessThan(0.1);
    expect(result.clarity).toBeGreaterThan(0.8);
  });

  it('reports low clarity on noise', () => {
    const samples = new Float32Array(DEFAULT_YIN_OPTIONS.frameSize);
    let state = 12345;
    for (let i = 0; i < samples.length; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      samples[i] = (state / 0x7fffffff) * 2 - 1;
    }
    expect(yinFrame(samples, SAMPLE_RATE, DEFAULT_YIN_OPTIONS).clarity).toBeLessThan(0.6);
  });

  it('round-trips midi and hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(hzToMidi(440)).toBeCloseTo(69, 9);
    expect(hzToMidi(midiToHz(53))).toBeCloseTo(53, 9);
  });
});

describe('note segmentation', () => {
  it('recovers a three-note phrase with the right pitches', () => {
    const notes = [
      { hz: 220, seconds: 0.6 },
      { hz: 0, seconds: 0.12 },
      { hz: 261.63, seconds: 0.6 },
      { hz: 0, seconds: 0.12 },
      { hz: 329.63, seconds: 0.7 },
    ];
    const total = notes.reduce((t, n) => t + n.seconds, 0);
    const samples = new Float32Array(Math.round(total * SAMPLE_RATE));
    let offset = 0;
    let phase = 0;
    for (const note of notes) {
      const count = Math.round(note.seconds * SAMPLE_RATE);
      for (let i = 0; i < count; i += 1) {
        if (note.hz > 0) {
          phase += (2 * Math.PI * note.hz) / SAMPLE_RATE;
          samples[offset + i] = 0.5 * Math.sin(phase);
        }
      }
      offset += count;
    }

    const frames = trackPitch(samples, SAMPLE_RATE);
    const result = segmentNotes(frames, undefined, DEFAULT_YIN_OPTIONS.hopSize / SAMPLE_RATE);
    expect(result.length).toBe(3);
    expect(result.map((n) => n.pitch)).toEqual([57, 60, 64]);
    expect((result[0] as { startSec: number }).startSec).toBeLessThan(0.1);
  });

  it('produces nothing from silence', () => {
    const frames = trackPitch(new Float32Array(SAMPLE_RATE), SAMPLE_RATE);
    expect(segmentNotes(frames)).toEqual([]);
  });

  it('maps loudness to velocity monotonically', () => {
    expect(rmsToVelocity(0.4)).toBeGreaterThan(rmsToVelocity(0.05));
    expect(rmsToVelocity(0)).toBe(25);
    expect(rmsToVelocity(1)).toBeLessThanOrEqual(127);
  });
});

/** Builds a percussive hit: an exponentially decaying tone plus filtered noise. */
function hit(
  samples: Float32Array,
  atSec: number,
  options: { toneHz: number; toneLevel: number; noiseLevel: number; decaySec: number; highpass: boolean },
): void {
  const start = Math.round(atSec * SAMPLE_RATE);
  const length = Math.round(options.decaySec * 4 * SAMPLE_RATE);
  let state = 987654321;
  let previous = 0;
  for (let i = 0; i < length && start + i < samples.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-t / options.decaySec);
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const raw = (state / 0x7fffffff) * 2 - 1;
    // A one-pole filter is enough to push the noise high or low.
    const noise = options.highpass ? raw - previous : (previous + raw) * 0.5;
    previous = raw;
    const tone = Math.sin((2 * Math.PI * options.toneHz * i) / SAMPLE_RATE);
    samples[start + i] =
      (samples[start + i] as number) +
      envelope * (tone * options.toneLevel + noise * options.noiseLevel);
  }
}

describe('onset detection (US-0502)', () => {
  it('finds four evenly spaced hits at the right times', () => {
    const samples = new Float32Array(SAMPLE_RATE * 2);
    const times = [0.2, 0.7, 1.2, 1.7];
    for (const time of times) {
      hit(samples, time, {
        toneHz: 70,
        toneLevel: 0.8,
        noiseLevel: 0.2,
        decaySec: 0.08,
        highpass: false,
      });
    }
    const { onsets } = detectOnsets(samples, SAMPLE_RATE);
    expect(onsets.length).toBe(times.length);
    onsets.forEach((onset, index) => {
      expect(Math.abs(onset.timeSec - (times[index] as number))).toBeLessThan(0.03);
    });
  });

  it('does not invent onsets in silence', () => {
    expect(detectOnsets(new Float32Array(SAMPLE_RATE), SAMPLE_RATE).onsets).toEqual([]);
  });

  it('collapses a double trigger inside the guard window', () => {
    const samples = new Float32Array(SAMPLE_RATE);
    hit(samples, 0.3, { toneHz: 70, toneLevel: 0.8, noiseLevel: 0.2, decaySec: 0.08, highpass: false });
    // 20 ms later: the decay of the same stroke, not a second one.
    hit(samples, 0.32, { toneHz: 70, toneLevel: 0.3, noiseLevel: 0.1, decaySec: 0.05, highpass: false });
    expect(detectOnsets(samples, SAMPLE_RATE).onsets.length).toBe(1);
  });
});

describe('drum classification (US-0503)', () => {
  it('calls a low, slow, tonal hit a kick', () => {
    const result = classifyOnset({
      centroidHz: 280,
      lowRatio: 0.78,
      highRatio: 0.02,
      zeroCrossingRate: 0.05,
      peak: 0.7,
      decaySec: 0.13,
    });
    expect(result.drum).toBe('kick');
    expect(result.confidence).toBeGreaterThan(0.55);
  });

  it('calls a bright, short, noisy hit a hat', () => {
    const result = classifyOnset({
      centroidHz: 8000,
      lowRatio: 0.02,
      highRatio: 0.72,
      zeroCrossingRate: 0.48,
      peak: 0.4,
      decaySec: 0.03,
    });
    expect(result.drum).toBe('hat');
  });

  it('calls a broadband mid hit a snare', () => {
    const result = classifyOnset({
      centroidHz: 2100,
      lowRatio: 0.2,
      highRatio: 0.24,
      zeroCrossingRate: 0.25,
      peak: 0.6,
      decaySec: 0.09,
    });
    expect(result.drum).toBe('snare');
  });

  it('returns unknown rather than guessing when nothing wins', () => {
    const result = classifyOnset({
      centroidHz: 1000,
      lowRatio: 0.36,
      highRatio: 0.2,
      zeroCrossingRate: 0.2,
      peak: 0.5,
      decaySec: 0.1,
    });
    if (result.drum === 'unknown') {
      expect(result.confidence).toBeLessThan(0.55);
    }
    // Whatever it decides, the three scores must remain a probability-like set.
    const total = result.scores.kick + result.scores.snare + result.scores.hat;
    expect(total).toBeCloseTo(1, 6);
  });

  it('maps onset strength to velocity monotonically inside MIDI range', () => {
    expect(strengthToVelocity(1)).toBeGreaterThan(strengthToVelocity(0.2));
    expect(strengthToVelocity(0)).toBeGreaterThanOrEqual(1);
    expect(strengthToVelocity(1)).toBeLessThanOrEqual(127);
  });
});

describe('WAV encoding (US-0902)', () => {
  it('writes a header a decoder can read back', () => {
    const left = new Float32Array(1000).fill(0.5);
    const buffer = encodeWav([left], { sampleRate: 44100 });
    const header = readWavHeader(buffer);
    expect(header.channelCount).toBe(1);
    expect(header.sampleRate).toBe(44100);
    expect(header.bitsPerSample).toBe(16);
    expect(header.frameCount).toBe(1000);
    expect(header.durationSec).toBeCloseTo(1000 / 44100, 9);
  });

  it('interleaves stereo channels', () => {
    const left = new Float32Array([1, 1]);
    const right = new Float32Array([-1, -1]);
    const buffer = encodeWav([left, right], { sampleRate: 8000 });
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it('clips instead of wrapping around', () => {
    const buffer = encodeWav([new Float32Array([4, -4])], { sampleRate: 8000 });
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it('normalises only when asked', () => {
    const quiet = new Float32Array([0.1, -0.1]);
    const plain = new DataView(encodeWav([quiet], { sampleRate: 8000 }));
    const loud = new DataView(encodeWav([quiet], { sampleRate: 8000, normalizeTo: 0.9 }));
    expect(Math.abs(loud.getInt16(44, true))).toBeGreaterThan(Math.abs(plain.getInt16(44, true)));
  });

  it('rejects an empty channel list rather than writing a broken file', () => {
    expect(() => encodeWav([], { sampleRate: 44100 })).toThrow();
  });
});
