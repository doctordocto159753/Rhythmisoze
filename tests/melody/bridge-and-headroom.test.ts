/**
 * Gap-bridging register discipline and the whisper-level gain headroom.
 *
 * The bridge used to refuse any gap whose interior candidates disagreed with
 * the endpoints by more than a semitone-and-a-half — which on quiet material
 * meant a passage that YIN read an octave flat refused to join the notes on
 * either side of it, leaving holes in phrases the performer sang straight
 * through. Agreement is now octave-aware, and the folded reading — never the
 * subharmonic — fills the gap.
 */
import { describe, expect, it } from 'vitest';
import type { MonoAudio } from '@contracts';
import {
  prepareVoiceAudio,
  smoothPitchContour,
  type PitchFrame,
} from '@/packages/melody-extraction';

function frameAt(
  timeSec: number,
  midiPitch: number | null,
  options: { confidence?: number; clarity?: number; rms?: number; candidateMidi?: number | null } = {},
): PitchFrame {
  const confidence = options.confidence ?? 0.9;
  const clarity = options.clarity ?? confidence;
  const candidate = options.candidateMidi === undefined ? midiPitch : options.candidateMidi;
  return {
    timeSec,
    frequencyHz: midiPitch === null ? null : 440 * 2 ** ((midiPitch - 69) / 12),
    midiPitch,
    candidateHz: candidate === null ? null : 440 * 2 ** ((candidate - 69) / 12),
    candidateMidi: candidate,
    clarity,
    confidence,
    rms: options.rms ?? 0.05,
    voiced: midiPitch !== null,
  };
}

describe('gap bridging register discipline', () => {
  it('refuses to bridge when the interior read an octave flat', () => {
    // Withdrawn behaviour, pinned as refused on purpose: a forensic pass on a
    // quiet articulated take showed that accepting octave-family agreement in
    // here let uncertain gap frames become pitch authority — segments merged
    // across articulation boundaries and phrase registers flipped an octave
    // flat downstream. Until a bridge design exists that cannot do that, an
    // octave-displaced interior is treated exactly like any other
    // disagreement.
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 8; i += 1) frames.push(frameAt(i * 0.01, 57));
    for (let i = 8; i < 18; i += 1) {
      frames.push(frameAt(i * 0.01, null, { candidateMidi: 45, clarity: 0.7 }));
    }
    for (let i = 18; i < 26; i += 1) frames.push(frameAt(i * 0.01, 57));

    const smoothed = smoothPitchContour(frames);
    const hole = smoothed.frames.slice(8, 18);

    expect(hole.every((frame) => frame.midiPitch === null)).toBe(true);
  });

  it('still refuses a gap whose interior is genuinely another pitch', () => {
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 8; i += 1) frames.push(frameAt(i * 0.01, 57));
    // A tritone away, consistently: something else sounded there.
    for (let i = 8; i < 18; i += 1) {
      frames.push(frameAt(i * 0.01, null, { candidateMidi: 51, clarity: 0.8 }));
    }
    for (let i = 18; i < 26; i += 1) frames.push(frameAt(i * 0.01, 57));

    const smoothed = smoothPitchContour(frames);
    const hole = smoothed.frames.slice(8, 18);

    expect(hole.every((frame) => frame.midiPitch === null)).toBe(true);
  });

  it('keeps refusing true silence regardless of length', () => {
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 8; i += 1) frames.push(frameAt(i * 0.01, 57));
    for (let i = 8; i < 14; i += 1) {
      frames.push(frameAt(i * 0.01, null, { candidateMidi: null, rms: 0.0005 }));
    }
    for (let i = 14; i < 22; i += 1) frames.push(frameAt(i * 0.01, 57));

    const smoothed = smoothPitchContour(frames);

    expect(smoothed.frames[10]?.midiPitch).toBe(null);
  });
});

describe('whisper-level gain headroom', () => {
  function sineAudio(peakAmplitude: number): MonoAudio {
    const sampleRate = 16_000;
    const samples = new Float32Array(sampleRate);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = peakAmplitude * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    }
    return { samples, sampleRate, durationSec: 1 };
  }

  it('lifts an ultra-quiet take into working range', () => {
    const prepared = prepareVoiceAudio(sineAudio(0.02).samples, 16_000);
    let peak = 0;
    for (const sample of prepared.samples) peak = Math.max(peak, Math.abs(sample));

    // The 16x cap puts a -34 dBFS take near -10 dBFS: quiet, but far from the
    // quantization floor that used to set the adaptive gate.
    expect(peak).toBeGreaterThan(0.25);
  });

  it('leaves ordinary takes exactly where they were', () => {
    const prepared = prepareVoiceAudio(sineAudio(0.4).samples, 16_000);
    let peak = 0;
    for (const sample of prepared.samples) peak = Math.max(peak, Math.abs(sample));

    expect(peak).toBeCloseTo(0.92, 1);
  });
});
