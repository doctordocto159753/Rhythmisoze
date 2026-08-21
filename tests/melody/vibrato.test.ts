import { describe, expect, it } from 'vitest';
import { extractHumanMelody, segmentPitchContour } from '@/packages/melody-extraction';
import { frameAt, synthesizeMelody } from './helpers';

describe('human melody extraction: vibrato', () => {
  it('keeps expressive vibrato as one note rather than fragmenting it', () => {
    const fixture = synthesizeMelody([64], {
      noteSec: 2,
      gapSec: 0,
      vibratoSemitones: 0.48,
    });
    const result = extractHumanMelody(fixture.audio);

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.pitch).toBe(64);
    const voiced = result.frames.filter((frame) => frame.midiPitch !== null);
    const span = Math.max(...voiced.map((frame) => frame.midiPitch as number)) -
      Math.min(...voiced.map((frame) => frame.midiPitch as number));
    expect(span).toBeGreaterThan(0.25);
    expect(span).toBeLessThan(1.5);
  });

  it('turns a continuous glissando into a small phrase, not dozens of notes', () => {
    const frames = Array.from({ length: 201 }, (_, index) =>
      frameAt(index * 0.01, 60 + (7 * index) / 200),
    );
    const segments = segmentPitchContour(frames);

    expect(segments.length).toBeGreaterThan(0);
    expect(segments.length).toBeLessThan(10);
  });
});
