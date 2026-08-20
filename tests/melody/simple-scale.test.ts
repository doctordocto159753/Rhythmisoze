import { describe, expect, it } from 'vitest';
import {
  extractHumanMelody,
  maximumPolyphony,
  trackFundamentalPitch,
} from '@/packages/melody-extraction';
import { synthesizeMelody } from './helpers';

describe('human melody extraction: simple scale', () => {
  it('finds C4 D4 E4 F4 G4 as one expressive melody line', () => {
    const fixture = synthesizeMelody([60, 62, 64, 65, 67]);
    const result = extractHumanMelody(fixture.audio);
    const agreementFrames = result.frames.filter((frame) =>
      fixture.labels.some((label) => frame.timeSec >= label.startSec && frame.timeSec < label.endSec),
    );
    const matchingFrames = agreementFrames.filter((frame) => {
      const label = fixture.labels.find(
        (item) => frame.timeSec >= item.startSec && frame.timeSec < item.endSec,
      );
      return frame.midiPitch !== null && label !== undefined && Math.abs(frame.midiPitch - label.pitch) <= 1;
    });

    expect(matchingFrames.length / agreementFrames.length).toBeGreaterThanOrEqual(0.8);
    expect(result.notes.map((note) => note.pitch)).toEqual([60, 62, 64, 65, 67]);
    expect(maximumPolyphony(result.notes)).toBe(1);
    expect(result.quality.clear).toBe(true);
  });

  it('marks silence unvoiced while retaining a confidence value per frame', () => {
    const frames = trackFundamentalPitch(new Float32Array(16_000), 16_000);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.frequencyHz === null && frame.midiPitch === null)).toBe(true);
    expect(frames.every((frame) => frame.confidence >= 0 && frame.confidence <= 1)).toBe(true);
  });
});
