/**
 * The teacher-notes wire serializer.
 *
 * These tests encode a real production failure: the Teacher's rhythm
 * refinement left an 8.2 ms overlap between two notes of a five-note phrase,
 * the service's monophonic contract refused the whole payload with a 422, and
 * every real generation died at submission while all UI tests — which mock the
 * boundary — stayed green. The serializer is the fix; these are its laws.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import { serializeTeacherNotes } from '@musician-client';

function note(startSec: number, endSec: number, pitch = 60, velocity = 96): NoteEvent {
  return { startSec, endSec, pitch, velocity, confidence: 0.9 };
}

describe('serializeTeacherNotes', () => {
  it('trims the captured 8.2 ms overlap instead of refusing the payload', () => {
    // The exact pair from the field failure: note 1 starts before note 0 ends.
    const notes = [
      note(0, 0.63, 57),
      note(0.6217616580310881, 1.2217616580310882, 59),
    ];
    const wire = serializeTeacherNotes(notes);
    expect(wire).toEqual([
      { pitch: 57, startSec: 0, endSec: 0.6217616580310881, velocity: 96 },
      { pitch: 59, startSec: 0.6217616580310881, endSec: 1.2217616580310882, velocity: 96 },
    ]);
    // And the output satisfies the contract's own rule for every pair.
    for (let index = 1; index < wire.length; index += 1) {
      const previous = wire[index - 1] as WireNoteLike;
      const current = wire[index] as WireNoteLike;
      expect(current.startSec).toBeGreaterThanOrEqual(previous.endSec - 1e-4);
    }
  });

  it('leaves clean material untouched', () => {
    const notes = [
      note(0, 0.5, 60),
      note(0.5, 1.0, 62),
      note(1.1, 1.6, 64),
    ];
    expect(serializeTeacherNotes(notes)).toEqual([
      { pitch: 60, startSec: 0, endSec: 0.5, velocity: 96 },
      { pitch: 62, startSec: 0.5, endSec: 1.0, velocity: 96 },
      { pitch: 64, startSec: 1.1, endSec: 1.6, velocity: 96 },
    ]);
  });

  it('keeps overlaps within the contract tolerance as-is', () => {
    // A 0.05 ms crossing is float noise; the service accepts it and so do we.
    const notes = [note(0, 0.5 + 5e-5), note(0.5, 1.0)];
    const wire = serializeTeacherNotes(notes);
    expect(wire[0]?.endSec).toBe(0.5 + 5e-5);
  });

  it('preserves note order so phrase indices keep pointing at the same notes', () => {
    const notes = [note(1.0, 2.0, 64), note(0.9, 3.0, 62)];
    expect(serializeTeacherNotes(notes)).toEqual([
      { pitch: 64, startSec: 1.0, endSec: 2.0, velocity: 96 },
      { pitch: 62, startSec: 0.9, endSec: 3.0, velocity: 96 },
    ]);
  });

  it('does not hide true polyphony by deleting an unrepairable note', () => {
    // Same-onset notes cannot be made monophonic by trimming a tail. Keeping
    // both lets the service refuse the structurally invalid input and keeps
    // every phrase index honest.
    const wire = serializeTeacherNotes([note(0.5, 0.5005, 64), note(0.5, 1.0, 62)]);
    expect(wire).toEqual([
      { pitch: 64, startSec: 0.5, endSec: 0.5005, velocity: 96 },
      { pitch: 62, startSec: 0.5, endSec: 1.0, velocity: 96 },
    ]);
  });

  it('still clamps pitches and velocities the service would refuse', () => {
    const wire = serializeTeacherNotes([note(0, 0.5, 128, 0), note(0.5, 1.0, -3, 999)]);
    expect(wire.map((n) => n.pitch)).toEqual([127, 0]);
    expect(wire.map((n) => n.velocity)).toEqual([1, 127]);
  });
});

interface WireNoteLike {
  startSec: number;
  endSec: number;
}
