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
  it('fills an octave-flat dropout at the endpoint register, as inference only', () => {
    // The withdrawn design failed here by writing the subharmonic into the
    // contour. The safe design closes the hole using the ENDPOINTS' register:
    // interior candidates are consulted for whether to fill, never for what
    // to write.
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 8; i += 1) frames.push(frameAt(i * 0.01, 57));
    // Interior reads ~45 while both endpoints are 57: register slip, not rest,
    // and the energy never drops — a sustained tone passing through weak
    // tracking, not an articulation.
    for (let i = 8; i < 18; i += 1) {
      frames.push(frameAt(i * 0.01, null, { candidateMidi: 45, clarity: 0.7 }));
    }
    for (let i = 18; i < 26; i += 1) frames.push(frameAt(i * 0.01, 57));

    const smoothed = smoothPitchContour(frames);
    const hole = smoothed.frames.slice(8, 18);

    expect(hole.every((frame) => frame.midiPitch !== null)).toBe(true);
    expect(hole.every((frame) => Math.abs((frame.midiPitch as number) - 57) <= 1)).toBe(true);
    expect(hole.every((frame) => frame.origin === 'interpolated')).toBe(true);
  });

  it('refuses a near-silent articulation even when candidates look agreeable', () => {
    // Regression guard for the measured failure mode: repeated staccato notes
    // whose articulation dips to digital silence must stay separate notes even
    // though every interior candidate agrees with the endpoints up to an
    // octave. Energy continuity, not candidate agreement, is what distinguishes
    // a dropout inside one note from the space between two.
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 8; i += 1) frames.push(frameAt(i * 0.01, 60));
    for (let i = 8; i < 18; i += 1) {
      const silentArticulation = i >= 11 && i <= 13;
      frames.push(
        frameAt(i * 0.01, null, {
          candidateMidi: 48,
          clarity: 0.7,
          rms: silentArticulation ? 0.0002 : 0.05,
        }),
      );
    }
    for (let i = 18; i < 26; i += 1) frames.push(frameAt(i * 0.01, 60));

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

  it('never bridges across an octave leap', () => {
    // Endpoints an octave apart are a real melodic event, whatever the
    // interior sounds like: endpoint agreement gates everything else.
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 8; i += 1) frames.push(frameAt(i * 0.01, 57));
    for (let i = 8; i < 14; i += 1) {
      frames.push(frameAt(i * 0.01, null, { candidateMidi: 63, clarity: 0.7 }));
    }
    for (let i = 14; i < 22; i += 1) frames.push(frameAt(i * 0.01, 69));

    const smoothed = smoothPitchContour(frames);
    const hole = smoothed.frames.slice(8, 14);

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
