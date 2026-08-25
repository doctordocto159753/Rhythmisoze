/**
 * The transformation-history diff.
 *
 * These records are the debug views' raw material, so the bar is simple: every
 * mechanical change a stage makes to a note set must appear exactly once, with
 * the right kind and the right pitches, and nothing else may appear. No
 * interpretation lives here — only facts a later view can assemble.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import { buildTransformationHistory, noteTransformations } from '@/packages/note-history';

function note(startSec: number, pitch: number, durationSec = 0.3): NoteEvent {
  return { startSec, endSec: startSec + durationSec, pitch, velocity: 90, confidence: 0.9 };
}

describe('noteTransformations', () => {
  it('reports no records when a stage changed nothing', () => {
    const notes = [note(0.5, 60), note(1.2, 64)];
    expect(noteTransformations('judge', notes, notes)).toEqual([]);
  });

  it('records a removed note', () => {
    const before = [note(0.5, 60), note(1.2, 64)];
    const after = [note(0.5, 60)];
    expect(noteTransformations('judge', before, after)).toEqual([
      { stage: 'judge', kind: 'removed', startSec: 1.2, endSec: 1.5, fromPitch: 64 },
    ]);
  });

  it('records an added note without a source pitch', () => {
    const before = [note(0.5, 60)];
    const after = [note(0.5, 60), note(1.4, 67, 0.25)];
    expect(noteTransformations('judge', before, after)).toEqual([
      { stage: 'judge', kind: 'added', startSec: 1.4, endSec: 1.65, toPitch: 67 },
    ]);
  });

  it('records a pitch shift with both registers', () => {
    const before = [note(0.5, 64)];
    const after = [note(0.5, 52)];
    expect(noteTransformations('judge', before, after)).toEqual([
      {
        stage: 'judge',
        kind: 'pitch-shifted',
        startSec: 0.5,
        endSec: 0.8,
        fromPitch: 64,
        toPitch: 52,
      },
    ]);
  });

  it('treats a same-pitch boundary change as a move, not a shift', () => {
    const before = [{ ...note(0.5, 60), endSec: 0.9 }];
    const after = [{ ...note(0.5, 60), endSec: 1.3 }];
    expect(noteTransformations('judge', before, after)).toEqual([
      {
        stage: 'judge',
        kind: 'moved',
        startSec: 0.5,
        endSec: 1.3,
        fromPitch: 60,
        toPitch: 60,
      },
    ]);
  });

  it('orders its output by time regardless of processing order', () => {
    const before = [note(2.0, 62), note(0.5, 60)];
    const after: NoteEvent[] = [];
    const stages = noteTransformations('judge', before, after).map((record) => record.startSec);
    expect(stages).toEqual([0.5, 2]);
  });
});

describe('buildTransformationHistory', () => {
  it('concatenates stages in the order they are given', () => {
    const candidate = [note(0.5, 64)];
    const judged = [note(0.5, 52)];
    const taught: NoteEvent[] = [];
    const history = buildTransformationHistory([
      { stage: 'judge', before: candidate, after: judged },
      { stage: 'teacher', before: judged, after: taught },
    ]);
    expect(history.map((record) => record.stage)).toEqual(['judge', 'teacher']);
    expect(history[0]).toMatchObject({ kind: 'pitch-shifted', fromPitch: 64, toPitch: 52 });
    expect(history[1]).toMatchObject({ kind: 'removed', fromPitch: 52 });
  });

  it('caps its length so a pathological take cannot flood diagnostics', () => {
    const before = Array.from({ length: 150 }, (_, index) => note(index * 0.5, 60 + (index % 5)));
    const after = before.slice(0, 100);
    const history = buildTransformationHistory(
      [
        { stage: 'a', before, after },
        { stage: 'b', before: after, after: [] },
      ],
      120,
    );
    expect(history).toHaveLength(120);
  });
});
