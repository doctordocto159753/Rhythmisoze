import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calculateMelodyConfidence,
  extractHumanMelody,
  maximumPolyphony,
  stabilizeSegmentOctaves,
} from '@/packages/melody-extraction';
import { frameAt, readPcm16Wav } from './helpers';

describe('human melody extraction: test22 regression', () => {
  it('anchors a false-bass phrase around its clear F#4 transition', () => {
    const segments = stabilizeSegmentOctaves([
      { startSec: 2.08, endSec: 2.35, midiPitch: 45, confidence: 0.71, intensity: 0.1 },
      { startSec: 2.55, endSec: 2.79, midiPitch: 47, confidence: 0.86, intensity: 0.1 },
      { startSec: 2.84, endSec: 3.29, midiPitch: 66, confidence: 0.87, intensity: 0.1 },
      { startSec: 3.34, endSec: 3.88, midiPitch: 47, confidence: 0.86, intensity: 0.1 },
    ]);

    expect(segments.map((segment) => Math.round(segment.midiPitch))).toEqual([57, 59, 66, 59]);
  });

  it('does not collapse to one repeated pitch and retains the F#4 transition', () => {
    const audio = readPcm16Wav(join(process.cwd(), 'tests/fixtures/audio/test22.wav'));
    const result = extractHumanMelody(audio);
    const pitches = result.notes.map((note) => note.pitch);

    expect(result.notes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pitches).size).toBeGreaterThanOrEqual(2);
    expect(
      pitches.some((pitch) => Math.abs(pitch - 66) <= 1),
      JSON.stringify(result.notes),
    ).toBe(true);
    expect(Math.min(...pitches), JSON.stringify(result.notes)).toBeGreaterThanOrEqual(48);
    expect(Math.max(...pitches), JSON.stringify(result.notes)).toBeLessThanOrEqual(67);
    expect(maximumPolyphony(result.notes)).toBe(1);
  });

  it('marks a mostly unvoiced fragment as unclear', () => {
    const frames = Array.from({ length: 100 }, (_, index) =>
      index < 3
        ? frameAt(index * 0.01, 60, { confidence: 0.7, rms: 0.05 })
        : frameAt(index * 0.01, null, { confidence: 0, rms: 0, candidateMidi: null }),
    );
    const quality = calculateMelodyConfidence(frames, [], null);

    expect(quality.clear).toBe(false);
    expect(quality.melodyConfidence).toBeLessThan(0.55);
  });
});
