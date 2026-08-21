/**
 * The real Musician output, used as a fixture.
 *
 * `artifacts/real-pipeline/` holds MIDI produced by an actual run of MelodyT5
 * and MIDI-RWKV against real Teacher material — the same package that was
 * inspected by hand when both of these bugs were found. Reading it here means
 * the length relationship the fix turns on is checked against something the
 * models actually produced rather than against numbers a test invented.
 *
 * What is asserted is the *relationship*, not the exact seconds: Expanded is
 * several times the length of the Teacher material it grew from, and everything
 * that measures the music has to follow it there. Pinning the artifact's own
 * durations would make a regenerated fixture look like a regression.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importMidi } from '@midi';
import { musicalDurationSec } from '@synthesis';

function loadVersion(name: string): { lastEndSec: number; noteCount: number } {
  const bytes = readFileSync(resolve(process.cwd(), 'artifacts/real-pipeline', `${name}.mid`));
  const imported = importMidi(new Uint8Array(bytes));
  const lastEndSec = imported.notes.reduce((end, note) => Math.max(end, note.endSec), 0);
  return { lastEndSec, noteCount: imported.notes.length };
}

describe('the real pipeline package', () => {
  const teacher = loadVersion('teacher');
  const expanded = loadVersion('musician-expanded');

  it('grew the idea well past the material it came from', () => {
    // The premise of the whole duration fix. If this stops being true the
    // Expanded version has stopped doing what it exists to do, and the tests
    // below are measuring nothing.
    expect(expanded.noteCount).toBeGreaterThan(teacher.noteCount * 2);
    expect(expanded.lastEndSec).toBeGreaterThan(teacher.lastEndSec * 2);
  });

  it('is measured to its own end rather than to the source it came from', () => {
    // The source duration is the Teacher material's span. Before the fix this
    // was the number playback and rendering used, so everything past it was
    // silently absent from what the user heard and downloaded.
    const sourceDurationSec = teacher.lastEndSec;
    const bytes = readFileSync(
      resolve(process.cwd(), 'artifacts/real-pipeline', 'musician-expanded.mid'),
    );
    const imported = importMidi(new Uint8Array(bytes));

    const span = musicalDurationSec(imported.notes, imported.drums, sourceDurationSec);
    expect(span).toBeCloseTo(expanded.lastEndSec, 6);
    expect(span).toBeGreaterThan(sourceDurationSec * 2);
  });

  it('leaves the shorter variants measured exactly as they always were', () => {
    // Refined and Developed sit at or near the source length, so nothing about
    // the ordinary case changes: the source duration is still the floor.
    for (const name of ['musician-refined', 'musician-developed']) {
      const bytes = readFileSync(resolve(process.cwd(), 'artifacts/real-pipeline', `${name}.mid`));
      const imported = importMidi(new Uint8Array(bytes));
      const generous = expanded.lastEndSec * 2;
      expect(musicalDurationSec(imported.notes, imported.drums, generous)).toBe(generous);
    }
  });
});
