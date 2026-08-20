/**
 * US-0401..US-0405 - the port is verified against the Python reference.
 *
 * Every expected value in `tests/fixtures/golden/` came out of the real
 * `humtool.py` (see `scripts/generate-golden-fixtures.py`). Nothing here asserts
 * what the algorithm ought to do; it asserts what the reference implementation
 * actually did on the same input.
 *
 * Tolerances (US-0401 acceptance criterion "tolerances are defined for
 * floating-point/time differences"):
 *  - integers - pitch, velocity, grid steps, counts - must match exactly;
 *  - seconds and correlation values are compared to 1e-9, which is far tighter
 *    than any musically meaningful difference and still absorbs the last-bit
 *    divergence between CPython and V8 double arithmetic.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GridNote, NoteEvent } from '@contracts';
import {
  buildReport,
  detectKey,
  estimateTempo,
  gridView,
  percussionMap,
  pitchName,
  quantize,
  snapToScale,
  sortNotes,
  stripOctaveErrors,
} from '@retouch';

const FLOAT_TOLERANCE = 1e-9;
const GOLDEN_DIR = join(process.cwd(), 'tests', 'fixtures', 'golden');

type RawNote = [number, number, number, number];
type RawGridNote = [number, number, number, number];

interface GoldenCase {
  name: string;
  bpm: number;
  mode: 'pitched' | 'drums';
  input: RawNote[];
  stripOctaveErrors: { kept: RawNote[]; dropped: number };
  estimateTempo: { bpm: number; gridError: number };
  detectKey: { root: string; mode: string; confidence: number | null };
  quantize: Record<string, { notes: RawGridNote[]; stepSec: number }>;
  snapToScale: Record<string, { notes: RawGridNote[]; moved: number }>;
  percussionMap: Record<string, RawGridNote[]>;
  report: Record<string, string | null>;
  gridView: Record<string, string>;
}

function loadCases(): GoldenCase[] {
  return readdirSync(GOLDEN_DIR)
    .filter((file) => file.endsWith('.json') && file !== 'index.json')
    .sort()
    .map((file) => JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as GoldenCase);
}

const toNote = ([startSec, endSec, pitch, velocity]: RawNote): NoteEvent => ({
  startSec,
  endSec,
  pitch,
  velocity,
});

const fromGrid = (note: GridNote): RawGridNote => [
  note.step,
  note.lengthSteps,
  note.pitch,
  note.velocity,
];

const cases = loadCases();

describe('golden fixtures', () => {
  it('has cases covering every branch the port has to reproduce', () => {
    const names = cases.map((c) => c.name);
    expect(names).toContain('half-step-rounding'); // round-half-to-even
    expect(names).toContain('octave-errors'); // strip_octave_errors
    expect(names).toContain('off-key'); // snap_to_scale
    expect(names).toContain('duplicate-onsets'); // quantize run collapsing
    expect(names).toContain('sparse'); // estimate_tempo fallback
    expect(names).toContain('empty'); // degenerate input
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });
});

describe.each(cases.map((c) => [c.name, c] as const))('humtool parity: %s', (_name, golden) => {
  const input = sortNotes(golden.input.map(toNote));

  it('strip_octave_errors', () => {
    const result = stripOctaveErrors(input);
    expect(result.dropped).toBe(golden.stripOctaveErrors.dropped);
    expect(result.kept.map((n) => [n.startSec, n.endSec, n.pitch, n.velocity])).toEqual(
      golden.stripOctaveErrors.kept,
    );
  });

  it('estimate_tempo', () => {
    const kept = golden.stripOctaveErrors.kept.map(toNote);
    const result = estimateTempo(kept);
    expect(result.bpm).toBe(golden.estimateTempo.bpm);
    expect(result.gridError).toBeCloseTo(golden.estimateTempo.gridError, 9);
  });

  it('detect_key', () => {
    const kept = golden.stripOctaveErrors.kept.map(toNote);
    const result = detectKey(kept);
    expect(result.root).toBe(golden.detectKey.root);
    expect(result.mode).toBe(golden.detectKey.mode);
    if (golden.detectKey.confidence === null) {
      // NumPy returns NaN for a flat histogram; the port must not invent a number.
      expect(Number.isFinite(result.confidence)).toBe(false);
    } else {
      expect(Math.abs(result.confidence - golden.detectKey.confidence)).toBeLessThan(
        FLOAT_TOLERANCE,
      );
    }
  });

  describe.each(['2', '4', '8'])('grid div=%s', (div) => {
    const kept = golden.stripOctaveErrors.kept.map(toNote);
    const divNumber = Number(div);

    it('quantize', () => {
      const expected = golden.quantize[div];
      if (!expected) throw new Error(`missing golden quantize for div=${div}`);
      const result = quantize(kept, golden.bpm, divNumber);
      expect(result.notes.map(fromGrid)).toEqual(expected.notes);
      expect(Math.abs(result.stepSec - expected.stepSec)).toBeLessThan(FLOAT_TOLERANCE);
    });

    it('snap_to_scale', () => {
      const expected = golden.snapToScale[div];
      const quantized = golden.quantize[div];
      if (!expected || !quantized) throw new Error(`missing golden snap for div=${div}`);
      const gridNotes: GridNote[] = quantized.notes.map(([step, lengthSteps, pitch, velocity]) => ({
        step,
        lengthSteps,
        pitch,
        velocity,
      }));
      const result = snapToScale(
        gridNotes,
        golden.detectKey.root as never,
        golden.detectKey.mode as never,
      );
      expect(result.moved).toBe(expected.moved);
      expect(result.notes.map(fromGrid)).toEqual(expected.notes);
    });

    it('percussion_map', () => {
      const expected = golden.percussionMap[div];
      const quantized = golden.quantize[div];
      if (!expected || !quantized) throw new Error(`missing golden percussion for div=${div}`);
      const gridNotes: GridNote[] = quantized.notes.map(([step, lengthSteps, pitch, velocity]) => ({
        step,
        lengthSteps,
        pitch,
        velocity,
      }));
      expect(percussionMap(gridNotes).map(fromGrid)).toEqual(expected);
    });

    it('grid_view', () => {
      const expected = golden.gridView[div];
      const quantized = golden.quantize[div];
      if (expected === undefined || !quantized) throw new Error(`missing golden grid ${div}`);
      const gridNotes: GridNote[] = quantized.notes.map(([step, lengthSteps, pitch, velocity]) => ({
        step,
        lengthSteps,
        pitch,
        velocity,
      }));
      expect(gridView(gridNotes, divNumber)).toBe(expected);
    });

    it('report metrics agree with the reference text', () => {
      const expected = golden.report[div];
      const quantized = golden.quantize[div];
      if (!quantized) throw new Error(`missing golden quantize for div=${div}`);
      const gridNotes: GridNote[] = quantized.notes.map(([step, lengthSteps, pitch, velocity]) => ({
        step,
        lengthSteps,
        pitch,
        velocity,
      }));
      const report = buildReport(
        golden.input.length,
        kept,
        golden.stripOctaveErrors.dropped,
        { bpm: golden.estimateTempo.bpm, gridError: golden.estimateTempo.gridError },
        {
          root: golden.detectKey.root as never,
          mode: golden.detectKey.mode as never,
          confidence: golden.detectKey.confidence ?? Number.NaN,
        },
        gridNotes,
      );

      if (expected === null) {
        // The reference raises here; the port must instead degrade to zeroes.
        expect(report.lowestPitch).toBe(0);
        expect(report.highestPitch).toBe(0);
        return;
      }

      expect(expected).toContain(`notes in        : ${report.notesIn}`);
      expect(expected).toContain(`octave errors   : ${report.octaveErrorsRemoved} removed`);
      expect(expected).toContain(
        `range           : ${pitchName(report.lowestPitch)} to ${pitchName(report.highestPitch)}`,
      );
      // `expected` is narrowed to string by the null check above, but the
      // narrowing does not survive the closure boundary of `describe.each`.
      const percentLine = /repeated notes  : (\d+)% of moves/.exec(expected as string);
      if (percentLine) {
        expect(Math.round(report.repeatedMovePercent)).toBe(Number(percentLine[1] ?? '0'));
      }
    });
  });
});
