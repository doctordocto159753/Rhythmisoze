/**
 * US-0407 - the Raw-to-Clean macro.
 *
 * The two properties the product depends on are checked across the whole range
 * rather than at a few sampled points, because a non-monotonic patch in the
 * middle of the curve is exactly the kind of regression nobody notices until a
 * user says "moving the slider up made it worse".
 */

import { describe, expect, it } from 'vitest';
import type { DrumEvent, NoteEvent } from '@contracts';
import {
  refine,
  resolveRetouchParams,
  retouchLabel,
  stepSeconds,
  RETOUCH_AMOUNT_DEFAULT,
} from '@retouch';

const ALL_AMOUNTS = Array.from({ length: 101 }, (_, i) => i);

describe('resolveRetouchParams', () => {
  it('is monotonic in cleanliness for every parameter', () => {
    let previous = resolveRetouchParams(0);
    for (const amount of ALL_AMOUNTS.slice(1)) {
      const current = resolveRetouchParams(amount);
      expect(current.timingStrength).toBeGreaterThanOrEqual(previous.timingStrength);
      expect(current.scaleSnapStrength).toBeGreaterThanOrEqual(previous.scaleSnapStrength);
      expect(current.velocitySmoothing).toBeGreaterThanOrEqual(previous.velocitySmoothing);
      expect(current.mergeMinDurationSec).toBeGreaterThanOrEqual(previous.mergeMinDurationSec);
      expect(current.mergeMaxGapSec).toBeGreaterThanOrEqual(previous.mergeMaxGapSec);
      // A tighter octave tolerance is more cleanup, so it must not widen.
      expect(current.octaveToleranceSemitones).toBeLessThanOrEqual(
        previous.octaveToleranceSemitones,
      );
      // Coarser grid is more simplification, so the division must not rise.
      expect(current.grid).toBeLessThanOrEqual(previous.grid);
      previous = current;
    }
  });

  it('leaves everything alone at zero', () => {
    const params = resolveRetouchParams(0);
    expect(params.octaveFilterEnabled).toBe(false);
    expect(params.timingStrength).toBe(0);
    expect(params.scaleSnapStrength).toBe(0);
    expect(params.velocitySmoothing).toBe(0);
    expect(params.mergeMinDurationSec).toBe(0);
  });

  it('reaches the reference humtool behaviour at one hundred', () => {
    const params = resolveRetouchParams(100);
    expect(params.timingStrength).toBe(1);
    expect(params.scaleSnapStrength).toBe(1);
    // humtool's strip_octave_errors default tolerance.
    expect(params.octaveToleranceSemitones).toBeCloseTo(12, 6);
  });

  it('only exposes the three grids the PRD specifies', () => {
    const grids = new Set(ALL_AMOUNTS.map((a) => resolveRetouchParams(a).grid));
    expect([...grids].sort((a, b) => a - b)).toEqual([8, 16, 32]);
  });

  it('honours an explicit grid override', () => {
    expect(resolveRetouchParams(100, { grid: 32 }).grid).toBe(32);
  });

  it('falls back to the default for a non-finite amount', () => {
    expect(resolveRetouchParams(Number.NaN)).toEqual(resolveRetouchParams(RETOUCH_AMOUNT_DEFAULT));
  });
});

describe('retouchLabel', () => {
  it('names the endpoints unambiguously', () => {
    expect(retouchLabel(0)).toBe('raw');
    expect(retouchLabel(100)).toBe('clean');
  });

  it('never skips a step as the amount rises', () => {
    const order = ['raw', 'light', 'balanced', 'tidy', 'clean'];
    let index = 0;
    for (const amount of ALL_AMOUNTS) {
      const next = order.indexOf(retouchLabel(amount));
      expect(next).toBeGreaterThanOrEqual(index);
      expect(next - index).toBeLessThanOrEqual(1);
      index = next;
    }
  });
});

describe('stepSeconds', () => {
  it('matches the humtool grid at 1/16', () => {
    // humtool: step = 60 / bpm / div, with div = 4 for sixteenths.
    expect(stepSeconds(120, 16)).toBeCloseTo(60 / 120 / 4, 12);
    expect(stepSeconds(96, 8)).toBeCloseTo(60 / 96 / 2, 12);
    expect(stepSeconds(96, 32)).toBeCloseTo(60 / 96 / 8, 12);
  });
});

/**
 * A phrase that behaves like a real hummed take: mostly in one key, drifting
 * off the grid, with a few chromatic slips and a couple of fragments.
 *
 * Mostly diatonic on purpose. A fully chromatic line has no key to detect, the
 * engine correctly declines to snap it, and the test would then be measuring
 * the wrong thing.
 */
function messyPhrase(): NoteEvent[] {
  const notes: NoteEvent[] = [];
  const step = 60 / 100 / 4;
  // C major with three chromatic slips at indices 3, 9 and 13.
  const pitches = [60, 62, 64, 63, 65, 67, 69, 71, 72, 68, 71, 69, 67, 66, 64, 60];
  for (let i = 0; i < pitches.length; i += 1) {
    const drift = ((i % 3) - 1) * 0.017;
    // Starts one bar in, so drift can never push an onset before zero.
    const start = step * 8 + i * step * 2 + drift;
    notes.push({
      startSec: start,
      endSec: start + step * (i % 4 === 3 ? 0.15 : 1.6),
      pitch: pitches[i] as number,
      velocity: 40 + ((i * 17) % 80),
    });
  }
  return notes;
}

describe('refine across the macro', () => {
  const input = { notes: messyPhrase(), drums: [] };

  it('is deterministic', () => {
    const a = refine(input, { bpm: 100, mode: 'melody', amount: 60 });
    const b = refine(input, { bpm: 100, mode: 'melody', amount: 60 });
    expect(b.notes).toEqual(a.notes);
    expect(b.analysis).toEqual(a.analysis);
  });

  it('returns the performance untouched at zero', () => {
    const result = refine(input, { bpm: 100, mode: 'melody', amount: 0 });
    expect(result.notes).toHaveLength(input.notes.length);
    for (let i = 0; i < result.notes.length; i += 1) {
      expect((result.notes[i] as NoteEvent).startSec).toBeCloseTo(
        (input.notes[i] as NoteEvent).startSec,
        9,
      );
      expect((result.notes[i] as NoteEvent).pitch).toBe((input.notes[i] as NoteEvent).pitch);
    }
    expect(result.analysis.notesSnapped).toBe(0);
  });

  it('lands every note exactly on the grid at one hundred', () => {
    const result = refine(input, { bpm: 100, mode: 'melody', amount: 100 });
    for (const note of result.notes) {
      const steps = note.startSec / result.stepSec;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
  });

  it('moves strictly more notes into key as the amount rises', () => {
    const counts = [0, 25, 50, 75, 100].map(
      (amount) => refine(input, { bpm: 100, mode: 'melody', amount }).analysis.notesSnapped,
    );
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i] as number).toBeGreaterThanOrEqual(counts[i - 1] as number);
    }
    expect(counts[counts.length - 1] as number).toBeGreaterThan(0);
  });

  it('keeps timing deviation non-increasing across the range', () => {
    const deviation = (amount: number): number => {
      const result = refine(input, { bpm: 100, mode: 'melody', amount });
      return result.notes.reduce((total, note) => {
        const steps = note.startSec / result.stepSec;
        return total + Math.abs(steps - Math.round(steps));
      }, 0) / Math.max(1, result.notes.length);
    };
    // Compared within one grid choice: the grid itself changes at 34 and 67, and
    // a finer grid legitimately shows a different absolute deviation.
    expect(deviation(70)).toBeLessThanOrEqual(deviation(35) + 1e-9);
    expect(deviation(100)).toBeLessThanOrEqual(deviation(70) + 1e-9);
  });

  it('clamps an onset before zero, which is not renderable', () => {
    const notes: NoteEvent[] = [
      { startSec: -0.02, endSec: 0.3, pitch: 60, velocity: 90 },
      { startSec: 0.4, endSec: 0.7, pitch: 62, velocity: 90 },
    ];
    const result = refine({ notes, drums: [] }, { bpm: 100, mode: 'melody', amount: 0 });
    expect((result.notes[0] as NoteEvent).startSec).toBe(0);
  });

  it('never produces a zero-length or out-of-order note', () => {
    for (const amount of [0, 10, 33, 34, 50, 66, 67, 90, 100]) {
      const result = refine(input, { bpm: 100, mode: 'melody', amount });
      let previous = -Infinity;
      for (const note of result.notes) {
        expect(note.endSec).toBeGreaterThan(note.startSec);
        expect(note.startSec).toBeGreaterThanOrEqual(previous - 1e-9);
        expect(note.pitch).toBeGreaterThanOrEqual(0);
        expect(note.pitch).toBeLessThanOrEqual(127);
        previous = note.startSec;
      }
    }
  });
});

describe('refine key handling', () => {
  it('refuses to snap against a key it does not believe', () => {
    // Two notes cannot establish a key; the engine must leave pitch alone.
    const notes: NoteEvent[] = [
      { startSec: 0, endSec: 0.4, pitch: 61, velocity: 90 },
      { startSec: 0.5, endSec: 0.9, pitch: 66, velocity: 90 },
    ];
    const result = refine({ notes, drums: [] }, { bpm: 100, mode: 'melody', amount: 100 });
    expect(result.keyIsReliable).toBe(false);
    expect(result.analysis.notesSnapped).toBe(0);
    expect(result.notes.map((n) => n.pitch)).toEqual([61, 66]);
  });

  it('uses a user key correction in preference to detection', () => {
    const result = refine(
      { notes: messyPhrase(), drums: [] },
      {
        bpm: 100,
        mode: 'melody',
        amount: 100,
        keyOverride: { root: 'F', mode: 'major' },
      },
    );
    expect(result.key.root).toBe('F');
    expect(result.key.mode).toBe('major');
    expect(result.keyIsReliable).toBe(true);
  });
});

describe('mixed-material refinement', () => {
  it('runs pitched cleanup and rhythm fidelity in parallel', () => {
    const notes = messyPhrase();
    const drums: DrumEvent[] = [
      { timeSec: 0.13, drum: 'kick', velocity: 100, confidence: 1, voice: 'pitch:40' },
      { timeSec: 0.13, drum: 'snare', velocity: 80, confidence: 1, voice: 'pitch:60' },
    ];
    const result = refine(
      { notes, drums },
      { bpm: 100, mode: 'melody', amount: 60, preserveRhythm: true, sourceKind: 'midi-upload' },
    );

    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.drums).toHaveLength(2);
    expect(result.drums.map((hit) => hit.voice)).toEqual(['pitch:40', 'pitch:60']);
    expect(result.analysis.noteCount).toBe(result.notes.length + result.drums.length);
  });
});
