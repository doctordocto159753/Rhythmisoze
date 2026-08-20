import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractHumanMelody, maximumPolyphony } from '@/packages/melody-extraction';
import { readPcm16Wav } from './helpers';

describe('human melody extraction: Recording (8) regression', () => {
  it('rejects false A1/A2 dominance and preserves a monophonic contour', () => {
    const audio = readPcm16Wav(join(process.cwd(), 'tests/fixtures/audio/recording-8.wav'));
    const result = extractHumanMelody(audio);

    expect(result.notes.length).toBeGreaterThanOrEqual(4);
    expect(maximumPolyphony(result.notes)).toBe(1);
    expect(result.notes.some((note) => note.pitch === 33 || note.pitch === 45)).toBe(false);
    expect(new Set(result.notes.map((note) => note.pitch)).size).toBeGreaterThanOrEqual(3);
    expect(result.quality.octaveStability).toBeGreaterThanOrEqual(0.98);
  });
});
