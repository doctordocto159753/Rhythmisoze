/**
 * Reading an imported MIDI into the mode the user asked for.
 *
 * ## The failure this exists for
 *
 * A user selected Rhythm and imported a rhythmic performance exported from
 * another application. It was written the ordinary way — pitched notes on
 * channel 1 — because that is what most tools produce unless you specifically
 * ask for General MIDI percussion. Rhythmisoze looked for channel 10, did not
 * find it, and concluded the user's rhythm was a melody:
 *
 * ```
 * state.mode === 'rhythm' && result.drums.length === 0  ->  'melody'
 * ```
 *
 * Channel 10 is a convention of the file format. Its absence is not evidence
 * about the music, and it is certainly not evidence that the person was wrong
 * about their own take. 145 percussive events went into the melodic pipeline.
 *
 * ## The four fixtures
 *
 * A — General MIDI percussion on channel 10.
 * B — pitched rhythm on channel 1, like the real file.
 * C — the same file imported deliberately as Melody.
 * D — a mixed file, melodic line plus percussive pitched material.
 */

import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { importMidi, interpretNotesAsRhythm, planMidiImport } from '@midi';

interface Hit {
  midi: number;
  timeSec: number;
  durationSec?: number;
  velocity?: number;
}

function buildMidi(tracks: Array<{ channel: number; notes: Hit[] }>): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(120);
  for (const spec of tracks) {
    const track = midi.addTrack();
    track.channel = spec.channel;
    for (const hit of spec.notes) {
      track.addNote({
        midi: hit.midi,
        time: hit.timeSec,
        duration: hit.durationSec ?? 0.09,
        velocity: (hit.velocity ?? 90) / 127,
      });
    }
  }
  return midi.toArray();
}

/** A — a standard General MIDI kit: kick, snare, hats on channel 10. */
const GM_DRUM_FILE = buildMidi([
  {
    channel: 9,
    notes: Array.from({ length: 16 }, (_, step) => [
      ...(step % 4 === 0 ? [{ midi: 36, timeSec: step * 0.25 }] : []),
      ...(step % 8 === 4 ? [{ midi: 38, timeSec: step * 0.25 }] : []),
      { midi: 42, timeSec: step * 0.25 },
    ]).flat(),
  },
]);

/**
 * B — the real file's shape: many short hits, several pitches, simultaneous
 * events, nothing on the percussion channel.
 */
const PITCHED_RHYTHM_FILE = buildMidi([
  {
    channel: 0,
    notes: Array.from({ length: 24 }, (_, step) => [
      ...(step % 4 === 0 ? [{ midi: 43, timeSec: step * 0.125, velocity: 100 }] : []),
      ...(step % 8 === 4 ? [{ midi: 62, timeSec: step * 0.125, velocity: 85 }] : []),
      { midi: 74, timeSec: step * 0.125, velocity: 60 },
    ]).flat(),
  },
]);

/** D — a melodic line and percussive pitched material in one file. */
const MIXED_FILE = buildMidi([
  {
    channel: 0,
    notes: [
      { midi: 60, timeSec: 0, durationSec: 0.45 },
      { midi: 62, timeSec: 0.5, durationSec: 0.45 },
      { midi: 64, timeSec: 1.0, durationSec: 0.45 },
      ...Array.from({ length: 8 }, (_, step) => ({
        midi: 42,
        timeSec: step * 0.25,
        durationSec: 0.05,
      })),
    ],
  },
]);

const POLYPHONIC_FILE = buildMidi([
  {
    channel: 0,
    notes: [
      { midi: 60, timeSec: 0, durationSec: 0.8 },
      { midi: 64, timeSec: 0, durationSec: 0.8 },
      { midi: 67, timeSec: 0, durationSec: 0.8 },
      { midi: 62, timeSec: 1, durationSec: 0.8 },
      { midi: 65, timeSec: 1, durationSec: 0.8 },
    ],
  },
]);

const DECLARED_MIXED_FILE = buildMidi([
  {
    channel: 0,
    notes: [
      { midi: 72, timeSec: 0, durationSec: 0.1 },
      { midi: 74, timeSec: 0.25, durationSec: 0.1 },
    ],
  },
  {
    channel: 9,
    notes: [
      { midi: 36, timeSec: 0, durationSec: 0.08 },
      { midi: 42, timeSec: 0.25, durationSec: 0.08 },
    ],
  },
]);

const STACCATO_CHORD_FILE = buildMidi([
  {
    channel: 0,
    notes: Array.from({ length: 12 }, (_, step) =>
      [60, 64, 67].map((midi) => ({
        midi,
        timeSec: step * 0.25,
        durationSec: 0.1,
      })),
    ).flat(),
  },
]);

const ARPEGGIO_FILE = buildMidi([
  {
    channel: 0,
    notes: Array.from({ length: 24 }, (_, step) => ({
      midi: [60, 64, 67, 72][step % 4] as number,
      timeSec: step * 0.125,
      durationSec: 0.08,
    })),
  },
]);

describe('A: a General MIDI drum file', () => {
  const file = importMidi(GM_DRUM_FILE);

  it('is read as percussion by the importer', () => {
    expect(file.drums.length).toBeGreaterThan(16);
    expect(file.notes).toHaveLength(0);
  });

  it('stays Rhythm when Rhythm is selected', () => {
    const plan = planMidiImport(file, 'rhythm');
    expect(plan.mode).toBe('rhythm');
    expect(plan.drums).toHaveLength(file.drums.length);
    expect(plan.pitchedNotesAsRhythm).toBe(0);
    expect(plan.modeChangedBecause).toBeNull();
  });

  it('is the one case that overrides the selected mode, and says so', () => {
    // Not the same kind of inference as the bug. Channel-10 note numbers name
    // instruments — 36 is a bass drum, not a C2 — so there is no melody in this
    // file to offer somebody who asked for one.
    const plan = planMidiImport(file, 'melody');
    expect(plan.mode).toBe('rhythm');
    expect(plan.modeChangedBecause).toBe('percussion-only');
  });
});

describe('B: a pitched rhythm with no percussion channel', () => {
  const file = importMidi(PITCHED_RHYTHM_FILE);

  it('arrives as pitched notes, exactly as the real file did', () => {
    expect(file.drums).toHaveLength(0);
    expect(file.notes.length).toBeGreaterThan(24);
  });

  it('stays Rhythm — the absence of channel 10 decides nothing', () => {
    // The assertion the old behaviour fails. It switched to melody here.
    const plan = planMidiImport(file, 'rhythm');
    expect(plan.mode).toBe('rhythm');
    expect(plan.modeChangedBecause).toBeNull();
  });

  it('keeps every event, with its own timing and velocity', () => {
    const plan = planMidiImport(file, 'rhythm');
    expect(plan.drums).toHaveLength(file.notes.length);
    expect(plan.pitchedNotesAsRhythm).toBe(file.notes.length);

    const sourceOnsets = file.notes.map((note) => note.startSec).sort((a, b) => a - b);
    const hitOnsets = plan.drums.map((drum) => drum.timeSec).sort((a, b) => a - b);
    expect(hitOnsets).toEqual(sourceOnsets);

    for (const drum of plan.drums) {
      const origin = file.notes.find(
        (note) => note.startSec === drum.timeSec && note.pitch === drum.sourcePitch,
      );
      expect(origin, `no source note for hit at ${drum.timeSec}`).toBeDefined();
      expect(drum.velocity).toBe(origin?.velocity);
    }
  });

  it('nothing is offered to the melodic pipeline', () => {
    // The invariant that matters most: a rhythm must not reach the melodic
    // Judge or Teacher, and the way that is guaranteed is that there are no
    // notes for them to read.
    expect(planMidiImport(file, 'rhythm').notes).toEqual([]);
  });

  it('keeps simultaneous hits simultaneous', () => {
    const plan = planMidiImport(file, 'rhythm');
    const count = (times: readonly number[]): number => {
      const byTime = new Map<string, number>();
      for (const time of times) {
        const key = time.toFixed(4);
        byTime.set(key, (byTime.get(key) ?? 0) + 1);
      }
      return Math.max(...byTime.values());
    };
    expect(count(plan.drums.map((d) => d.timeSec))).toBe(
      count(file.notes.map((n) => n.startSec)),
    );
  });

  it('separates the layers rather than flattening them to one class', () => {
    // Three pitches playing three parts must not become three of the same hit,
    // or the pattern is gone even though the event count survived.
    const plan = planMidiImport(file, 'rhythm');
    expect(new Set(plan.drums.map((drum) => drum.drum)).size).toBe(3);
  });
});

describe('C: the same pitched file imported as Melody', () => {
  const file = importMidi(PITCHED_RHYTHM_FILE);

  it('is a melody, because the user said so', () => {
    const plan = planMidiImport(file, 'melody');
    expect(plan.mode).toBe('melody');
    expect(plan.notes).toHaveLength(file.notes.length);
    expect(plan.drums).toEqual([]);
    expect(plan.modeChangedBecause).toBeNull();
  });
});

describe('D: a file with both a melodic line and percussive material', () => {
  const file = importMidi(MIXED_FILE);

  it('does not silently change whichever mode is selected', () => {
    expect(planMidiImport(file, 'melody').mode).toBe('melody');
    expect(planMidiImport(file, 'rhythm').mode).toBe('rhythm');
    expect(planMidiImport(file, 'melody').modeChangedBecause).toBeNull();
    expect(planMidiImport(file, 'rhythm').modeChangedBecause).toBeNull();
  });

  it('gives each mode the whole file, read its way', () => {
    // Ambiguity is resolved by the choice already made, not by a second prompt
    // asking the user to make it again.
    expect(planMidiImport(file, 'melody').notes).toHaveLength(file.notes.length);
    expect(planMidiImport(file, 'rhythm').drums).toHaveLength(file.notes.length);
  });
});

describe('reading pitched notes as hits', () => {
  it('assigns classes by register, low to high', () => {
    const hits = interpretNotesAsRhythm([
      { pitch: 40, startSec: 0, endSec: 0.1, velocity: 90 },
      { pitch: 60, startSec: 0.1, endSec: 0.2, velocity: 90 },
      { pitch: 80, startSec: 0.2, endSec: 0.3, velocity: 90 },
    ]);
    expect(hits.map((hit) => hit.drum)).toEqual(['kick', 'snare', 'hat']);
  });

  it('ranks pitches rather than measuring them, so a narrow range still separates', () => {
    // Three pitches a semitone apart are still three parts. Splitting by
    // absolute register would put all of them in one class.
    const hits = interpretNotesAsRhythm([
      { pitch: 60, startSec: 0, endSec: 0.1, velocity: 90 },
      { pitch: 61, startSec: 0.1, endSec: 0.2, velocity: 90 },
      { pitch: 62, startSec: 0.2, endSec: 0.3, velocity: 90 },
    ]);
    expect(new Set(hits.map((hit) => hit.drum)).size).toBe(3);
  });

  it('keeps the note the file actually contained', () => {
    const hits = interpretNotesAsRhythm([
      { pitch: 47, startSec: 0.5, endSec: 0.6, velocity: 77 },
    ]);
    expect(hits[0]?.sourcePitch).toBe(47);
    expect(hits[0]?.velocity).toBe(77);
    expect(hits[0]?.timeSec).toBe(0.5);
  });

  it('says it is certain, because a file is not a detector', () => {
    const hits = interpretNotesAsRhythm([
      { pitch: 47, startSec: 0, endSec: 0.1, velocity: 77 },
    ]);
    expect(hits[0]?.confidence).toBe(1);
  });

  it('has nothing to say about an empty melody', () => {
    expect(interpretNotesAsRhythm([])).toEqual([]);
  });
});

describe('internal MIDI classification and routing', () => {
  it('auto-routes declared percussion without a user mode', () => {
    const plan = planMidiImport(importMidi(GM_DRUM_FILE));
    expect(plan.classification.type).toBe('rhythm');
    expect(plan.mode).toBe('rhythm');
    expect(plan.notes).toEqual([]);
  });

  it('recognizes a dense short-note pitched rhythm without reading channel as intent', () => {
    const file = importMidi(PITCHED_RHYTHM_FILE);
    const plan = planMidiImport(file);
    expect(plan.classification.type).toBe('rhythm');
    expect(plan.drums).toHaveLength(file.notes.length);
    expect(plan.drums.map((hit) => hit.sourcePitch)).toEqual(
      expect.arrayContaining(file.notes.map((note) => note.pitch)),
    );
  });

  it('routes overlapping sustained notes as polyphonic and keeps every note', () => {
    const file = importMidi(POLYPHONIC_FILE);
    const plan = planMidiImport(file);
    expect(plan.classification.type).toBe('polyphonic');
    expect(plan.notes).toEqual(file.notes);
    expect(plan.judge?.notes).toEqual(file.notes);
  });

  it('splits mixed MIDI into pitched and rhythmic streams without collisions', () => {
    const plan = planMidiImport(importMidi(MIXED_FILE));
    expect(plan.classification.type).toBe('mixed');
    expect(plan.notes).toHaveLength(11);
    expect(plan.drums).toHaveLength(11);
    expect(plan.judge?.notes).toEqual(plan.notes);
    expect(new Set(plan.drums.map((hit) => hit.sourcePitch))).toEqual(
      new Set(plan.notes.map((note) => note.pitch)),
    );
  });

  it('trusts declared stream identity and keeps short melodic notes pitched', () => {
    const file = importMidi(DECLARED_MIXED_FILE);
    const plan = planMidiImport(file);
    expect(plan.classification.type).toBe('mixed');
    expect(plan.notes).toEqual(file.notes);
    expect(plan.drums).toEqual(file.drums);
    expect(plan.pitchedNotesAsRhythm).toBe(0);
  });

  it('keeps repeated staccato triads pitched instead of collapsing them to drums', () => {
    const file = importMidi(STACCATO_CHORD_FILE);
    const plan = planMidiImport(file);
    expect(plan.classification.type).toBe('polyphonic');
    expect(plan.notes).toEqual(file.notes);
    expect(plan.drums).toEqual([]);
    expect(plan.judge?.notes).toEqual(file.notes);
  });

  it('preserves a short-note arpeggio when rhythm evidence is ambiguous', () => {
    const file = importMidi(ARPEGGIO_FILE);
    const plan = planMidiImport(file);
    expect(plan.classification.type).not.toBe('rhythm');
    expect(plan.notes).toEqual(file.notes);
  });
});
