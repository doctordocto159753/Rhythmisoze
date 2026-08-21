/**
 * The real file that exposed both bugs, as a regression fixture.
 *
 * `tests/fixtures/midi/pitched-rhythm-export.mid` is the user's own
 * `Recording(7).mid`: a rhythmic performance exported from another application
 * as pitched notes on channel 1. 1.2 KB, so it costs nothing to keep, and it is
 * symbolic note data rather than a recording of anyone.
 *
 * ## What the exported package showed
 *
 * ```
 * Recording(7).mid   145 events, 15 pitches, up to 3 at once
 * unprocessed.mid    145 events — identical to the source
 * judge.mid           12 events, every one at pitch 50
 * teacher.mid         12 events, the same twelve
 * manifest.json       "mode": "melody"
 * ```
 *
 * Two separate faults, both visible in that. The mode flipped because the file
 * has nothing on the General MIDI percussion channel, and the twelve notes came
 * from the previous recording's Judge verdict surviving the import — see
 * `midi-mode.test.ts` and `source-isolation.test.ts` for each.
 *
 * What is measured here is the thing the user actually lost: whether the events
 * in the file are still the events in the app afterwards.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refine } from '@retouch';
import { analyzeDrumRhythm } from '@rhythm-extraction';
import { importMidi, planMidiImport } from '@midi';

const file = importMidi(
  new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/midi/pitched-rhythm-export.mid'))),
);

/** Highest number of events sharing one exact onset. */
function simultaneity(times: readonly number[]): number {
  const byTime = new Map<string, number>();
  for (const time of times) {
    const key = time.toFixed(4);
    byTime.set(key, (byTime.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...byTime.values());
}

describe('the file itself', () => {
  it('is the one from the report', () => {
    // The premise. If the fixture is ever replaced these numbers say so.
    expect(file.notes).toHaveLength(145);
    expect(file.drums).toHaveLength(0);
    expect(new Set(file.notes.map((note) => note.pitch)).size).toBe(15);
    expect(simultaneity(file.notes.map((note) => note.startSec))).toBe(3);
  });
});

describe('imported while Rhythm is selected', () => {
  const plan = planMidiImport(file, 'rhythm');

  it('stays Rhythm', () => {
    // The package says `"mode": "melody"`. This is that line.
    expect(plan.mode).toBe('rhythm');
    expect(plan.modeChangedBecause).toBeNull();
  });

  it('keeps all 145 events', () => {
    expect(plan.drums).toHaveLength(145);
    expect(plan.pitchedNotesAsRhythm).toBe(145);
  });

  it('moves no onset by any amount at all', () => {
    // The source is already symbolic. There is no interpretation stage here
    // whose output should differ from its input by a millisecond.
    const source = file.notes.map((note) => note.startSec).sort((a, b) => a - b);
    const hits = plan.drums.map((drum) => drum.timeSec).sort((a, b) => a - b);
    expect(hits).toHaveLength(source.length);
    const worst = Math.max(...source.map((time, index) => Math.abs(time - (hits[index] as number))));
    expect(worst).toBe(0);
  });

  it('keeps every velocity', () => {
    for (const drum of plan.drums) {
      const origin = file.notes.find(
        (note) => note.startSec === drum.timeSec && note.pitch === drum.sourcePitch,
      );
      expect(origin?.velocity).toBe(drum.velocity);
    }
  });

  it('keeps hits that were simultaneous simultaneous', () => {
    expect(simultaneity(plan.drums.map((drum) => drum.timeSec))).toBe(3);
  });

  it('keeps the pattern the length it was', () => {
    const lastSource = Math.max(...file.notes.map((note) => note.startSec));
    const lastHit = Math.max(...plan.drums.map((drum) => drum.timeSec));
    expect(lastHit).toBe(lastSource);
  });

  it('spreads the fifteen pitches across the three classes', () => {
    // Not "all pitches to one class to satisfy the type". The file's three main
    // layers — 62, 69 and 74, thirty-seven hits each — have to stay three parts.
    const byClass = new Map<string, number>();
    for (const drum of plan.drums) byClass.set(drum.drum, (byClass.get(drum.drum) ?? 0) + 1);
    expect(byClass.size).toBe(3);
    for (const count of byClass.values()) expect(count).toBeGreaterThan(20);

    const classOf = (pitch: number): string =>
      plan.drums.find((drum) => drum.sourcePitch === pitch)?.drum ?? 'missing';
    expect(new Set([classOf(62), classOf(69), classOf(74)]).size).toBe(3);
  });

  it('offers nothing to the melodic pipeline', () => {
    // 145 percussive events reaching the melodic Judge is the whole of the
    // first bug. There is nothing for it to read.
    expect(plan.notes).toEqual([]);
  });

  it('survives Unprocessed with every event intact', () => {
    const result = refine(
      { notes: [], drums: plan.drums },
      { bpm: file.bpm, mode: 'rhythm', amount: 0, sourceKind: 'midi-upload' },
    );
    expect(result.drums).toHaveLength(145);
    expect(result.notes).toEqual([]);
  });

  it('loses only what the cleanup control is documented to lose', () => {
    // At full Raw-to-Clean, two hits of one class landing on one grid step
    // become one — the collision rule the rhythm path has always had. It costs
    // 24 of 145 here, and it is a choice the user makes with a slider rather
    // than something an import does to them.
    const cleaned = refine(
      { notes: [], drums: plan.drums },
      { bpm: file.bpm, mode: 'rhythm', amount: 100, sourceKind: 'midi-upload' },
    );
    expect(cleaned.drums.length).toBeGreaterThan(115);
    expect(cleaned.drums.length).toBeLessThanOrEqual(145);
  });

  it('reads as a rhythm with a pulse of its own', () => {
    const analysis = analyzeDrumRhythm(plan.drums, file.durationSec);
    expect(analysis.measured).toBe(true);
    expect(analysis.onsetCount).toBe(145);
  });
});

describe('imported while Melody is selected', () => {
  it('is a melody, and keeps all 145 notes', () => {
    // The user is allowed to read it that way. What they are not allowed to
    // have is the app deciding it for them.
    const plan = planMidiImport(file, 'melody');
    expect(plan.mode).toBe('melody');
    expect(plan.notes).toHaveLength(145);
    expect(plan.modeChangedBecause).toBeNull();
  });
});
