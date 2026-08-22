/**
 * What correcting a rhythm is allowed to change.
 *
 * ## The eight hits
 *
 * A user's imported rhythm — fifteen pitched layers, 145 events — lost eight of
 * them at the default cleanup. Every one was traced:
 *
 * ```
 * amount   lost   cause
 * 0          0    (merging is off at zero)
 * 55         8    all eight: two different source layers sharing a kit slot
 * 100       24    13 the same, 11 two hits of one layer pulled onto one step
 * ```
 *
 * Not one was a duplicate. The quantizer merged "two hits of the same drum on
 * one step", which is a sound rule when the drum class is the finest thing
 * known about a hit, and became false the moment fifteen layers were rendered
 * through a three-slot kit. The adapter manufactured the collisions and the
 * quantizer believed them.
 *
 * ## The rule these hold
 *
 * Different source events stay different events, at every cleanup setting.
 * Correction moves timing; it does not decide that two parts were one.
 *
 * The exception is deliberate and narrow: a *detector* can genuinely report one
 * physical hit twice, so audio keeps the merge. A file cannot.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { drumVoiceOf, type DrumEvent } from '@contracts';
import { importMidi, planMidiImport, rhythmToMidi } from '@midi';
import { measureRhythmFidelity, refine, RETOUCH_AMOUNT_DEFAULT } from '@retouch';

const REAL_FILE = importMidi(
  new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/midi/pitched-rhythm-export.mid'))),
);

function correct(
  drums: readonly DrumEvent[],
  amount: number,
  bpm = 120,
  sourceKind: 'midi-upload' | 'recording' = 'midi-upload',
) {
  return refine({ notes: [], drums }, { bpm, mode: 'rhythm', amount, sourceKind });
}

/** A hit on a pitched-rhythm voice, as the importer would produce it. */
function hit(pitch: number, timeSec: number, velocity = 90, drum: DrumEvent['drum'] = 'snare'): DrumEvent {
  return { timeSec, drum, voice: `pitch:${pitch}`, sourcePitch: pitch, velocity, confidence: 1 };
}

describe('the real imported rhythm', () => {
  const plan = planMidiImport(REAL_FILE, 'rhythm');

  it('arrives with every event and every layer', () => {
    expect(plan.drums).toHaveLength(145);
    expect(new Set(plan.drums.map(drumVoiceOf)).size).toBe(15);
  });

  it('is untouched at cleanup zero', () => {
    // "Unprocessed must be sacred": for a symbolic source this is not a
    // near-identity, it is identity.
    const metrics = measureRhythmFidelity(plan.drums, correct(plan.drums, 0).drums);
    expect(metrics.correctedEvents).toBe(145);
    expect(metrics.eventRetention).toBe(1);
    expect(metrics.maxOnsetErrorSec).toBe(0);
    expect(metrics.maxVelocityError).toBe(0);
    expect(metrics.voiceRetention).toBe(1);
    expect(metrics.simultaneityRetention).toBe(1);
    expect(metrics.mergedEvents).toBe(0);
    expect(metrics.deletedEvents).toBe(0);
  });

  it('keeps all 145 events at the default cleanup', () => {
    // Was 137. The eight that used to go were all cross-layer collisions.
    const metrics = measureRhythmFidelity(plan.drums, correct(plan.drums, RETOUCH_AMOUNT_DEFAULT).drums);
    expect(metrics.correctedEvents).toBe(145);
    expect(metrics.eventRetention).toBe(1);
    expect(metrics.mergedEvents).toBe(0);
    expect(metrics.deletedEvents).toBe(0);
  });

  it('moves timing at the default cleanup, and only timing', () => {
    // What correction is *for*. Bounded by half a grid step, because a
    // quantizer that moves an event further than that has put it on a
    // different beat rather than tightened it.
    const metrics = measureRhythmFidelity(plan.drums, correct(plan.drums, RETOUCH_AMOUNT_DEFAULT).drums);
    expect(metrics.medianOnsetErrorSec).toBeGreaterThan(0);
    expect(metrics.maxOnsetErrorSec).toBeLessThanOrEqual(0.0625);
    expect(metrics.maxVelocityError).toBe(0);
    expect(metrics.voiceRetention).toBe(1);
    expect(metrics.simultaneityRetention).toBe(1);
  });

  it('keeps all 145 events at maximum cleanup too', () => {
    // Was 121. Maximum cleanup is the strongest version of the same idea, not
    // permission to simplify the pattern.
    const metrics = measureRhythmFidelity(plan.drums, correct(plan.drums, 100).drums);
    expect(metrics.correctedEvents).toBe(145);
    expect(metrics.eventRetention).toBe(1);
    expect(metrics.voiceRetention).toBe(1);
    expect(metrics.mergedEvents).toBe(0);
    expect(metrics.deletedEvents).toBe(0);
    expect(metrics.maxOnsetErrorSec).toBeLessThanOrEqual(0.125);
  });

  it('keeps its layers distinguishable through a MIDI round trip', () => {
    // The export used to write everything to the percussion channel, which
    // means through the three kit slots: fifteen layers out, three back.
    const corrected = correct(plan.drums, RETOUCH_AMOUNT_DEFAULT).drums;
    const bytes = rhythmToMidi(corrected, {
      bpm: REAL_FILE.bpm,
      meter: REAL_FILE.meter,
      title: 'round trip',
      program: 0,
    });
    const back = importMidi(bytes);
    expect(back.notes).toHaveLength(145);
    expect(new Set(back.notes.map((note) => note.pitch)).size).toBe(15);
  });

  it('moves everything monotonically further as cleanup rises', () => {
    const at = (amount: number) =>
      measureRhythmFidelity(plan.drums, correct(plan.drums, amount).drums).medianOnsetErrorSec;
    expect(at(0)).toBe(0);
    expect(at(RETOUCH_AMOUNT_DEFAULT)).toBeGreaterThan(at(0));
    expect(at(100)).toBeGreaterThanOrEqual(at(RETOUCH_AMOUNT_DEFAULT));
  });
});

describe('1: three layers on one instant', () => {
  const drums = [hit(60, 1, 90), hit(67, 1, 80), hit(74, 1, 70)];

  it('stays three events at every cleanup setting', () => {
    for (const amount of [0, RETOUCH_AMOUNT_DEFAULT, 100]) {
      const out = correct(drums, amount).drums;
      expect(out, `amount ${amount}`).toHaveLength(3);
      expect(new Set(out.map(drumVoiceOf)).size).toBe(3);
    }
  });

  it('keeps them together', () => {
    const metrics = measureRhythmFidelity(drums, correct(drums, 100).drums);
    expect(metrics.simultaneityRetention).toBe(1);
    expect(metrics.correctedMaxSimultaneity).toBe(3);
  });
});

describe('2: two layers that share a kit slot', () => {
  it('does not merge them, however identically they are voiced', () => {
    // The exact shape of the eight lost hits: same class, same step, different
    // parts. Both are deliberately given `drum: 'snare'`.
    const drums = [hit(63, 4.0, 58, 'snare'), hit(70, 4.0, 51, 'snare')];
    for (const amount of [0, RETOUCH_AMOUNT_DEFAULT, 100]) {
      const out = correct(drums, amount).drums;
      expect(out, `amount ${amount}`).toHaveLength(2);
      expect(new Set(out.map((event) => event.sourcePitch))).toEqual(new Set([63, 70]));
    }
  });
});

describe('3: one layer struck twice in quick succession', () => {
  const drums = [hit(62, 2.0, 60), hit(62, 2.1, 70)];

  it('keeps both', () => {
    for (const amount of [0, RETOUCH_AMOUNT_DEFAULT, 100]) {
      expect(correct(drums, amount).drums, `amount ${amount}`).toHaveLength(2);
    }
  });

  it('never lets full quantization stack them into silence', () => {
    // Both would land on the same 1/8 step. Surviving as data and vanishing as
    // sound is not surviving.
    const out = correct(drums, 100).drums.sort((a, b) => a.timeSec - b.timeSec);
    expect((out[1] as DrumEvent).timeSec - (out[0] as DrumEvent).timeSec).toBeGreaterThanOrEqual(
      0.029,
    );
  });

  it('keeps them in the order they were played', () => {
    const out = correct(drums, 100).drums.sort((a, b) => a.timeSec - b.timeSec);
    expect((out[0] as DrumEvent).velocity).toBe(60);
    expect((out[1] as DrumEvent).velocity).toBe(70);
  });
});

describe('4: two identical events at the same instant', () => {
  const drums = [hit(62, 3.0, 80), hit(62, 3.0, 80)];

  it('keeps both, because a file is not a detector', () => {
    // The rule, stated so it is a decision rather than an accident: a MIDI file
    // saying a thing twice is a file that means it twice — doubling a hit is a
    // real production technique. Only a detector can see one event and report
    // two, so only audio is allowed to undo it.
    expect(correct(drums, 0).drums).toHaveLength(2);
    expect(correct(drums, RETOUCH_AMOUNT_DEFAULT).drums).toHaveLength(2);
  });

  it('merges them for a recorded take, where they are one hit heard twice', () => {
    const detected: DrumEvent[] = [
      { timeSec: 3.0, drum: 'snare', velocity: 80, confidence: 0.8 },
      { timeSec: 3.0, drum: 'snare', velocity: 74, confidence: 0.7 },
    ];
    expect(correct(detected, RETOUCH_AMOUNT_DEFAULT, 120, 'recording').drums).toHaveLength(1);
  });
});

describe('5: a General MIDI kit', () => {
  function gmFile(): Uint8Array {
    const midi = new Midi();
    midi.header.setTempo(120);
    const track = midi.addTrack();
    track.channel = 9;
    for (const note of [36, 38, 42]) {
      track.addNote({ midi: note, time: 1, duration: 0.1, velocity: 0.8 });
    }
    // A side stick, which GM voices through the same kit slot as the snare.
    track.addNote({ midi: 37, time: 1, duration: 0.1, velocity: 0.6 });
    return midi.toArray();
  }

  const plan = planMidiImport(importMidi(gmFile()), 'rhythm');

  it('keeps the real General MIDI identities', () => {
    // Channel 10 note numbers name instruments, so unlike a pitched file these
    // classes are evidence rather than a guess.
    expect(plan.drums.map((d) => d.sourcePitch).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      36, 37, 38, 42,
    ]);
    expect(new Set(plan.drums.map(drumVoiceOf)).size).toBe(4);
  });

  it('does not fold the side stick into the snare', () => {
    // Both are voiced through `snare` and land on one step. They are different
    // instruments and stay different events.
    for (const amount of [0, RETOUCH_AMOUNT_DEFAULT, 100]) {
      expect(correct(plan.drums, amount).drums, `amount ${amount}`).toHaveLength(4);
    }
  });

  it('exports back to the percussion channel', () => {
    // GM in, GM out: these hits really are drums and the channel says so.
    const bytes = rhythmToMidi(correct(plan.drums, 0).drums, {
      bpm: 120,
      meter: { beatsPerBar: 4, beatUnit: 4 },
      title: 'gm',
      program: 0,
    });
    expect(importMidi(bytes).drums.length).toBe(4);
  });
});

describe('6: fifteen pitched layers', () => {
  it('remain fifteen distinguishable layers after correction', () => {
    const plan = planMidiImport(REAL_FILE, 'rhythm');
    for (const amount of [0, RETOUCH_AMOUNT_DEFAULT, 100]) {
      const out = correct(plan.drums, amount).drums;
      expect(new Set(out.map(drumVoiceOf)).size, `amount ${amount}`).toBe(15);
      expect(new Set(out.map((event) => event.sourcePitch)).size).toBe(15);
    }
  });
});

describe('the fifteen layers, as heard', () => {
  const plan = planMidiImport(REAL_FILE, 'rhythm');

  it('are fifteen distinguishable sounds, not three', () => {
    // The kit has three slots, so preserving fifteen layers in the data still
    // leaves a listener hearing three parts unless the slots are tuned apart.
    // A layer's sound is its slot plus its tuning.
    const audible = new Set(plan.drums.map((event) => `${event.drum}@${event.tuneSemitones ?? 0}`));
    expect(audible.size).toBe(15);
  });

  it('stay inside their own kit slot', () => {
    // Tuned, not transposed to somewhere else: a kick shifted an octave is no
    // longer a kick, and the pattern would stop sounding like a kit.
    for (const event of plan.drums) {
      expect(Math.abs(event.tuneSemitones ?? 0)).toBeLessThanOrEqual(7);
    }
  });

  it('survive correction with their sound intact', () => {
    const out = correct(plan.drums, RETOUCH_AMOUNT_DEFAULT).drums;
    const audible = new Set(out.map((event) => `${event.drum}@${event.tuneSemitones ?? 0}`));
    expect(audible.size).toBe(15);
  });

  it('leave General MIDI alone, where the sound already names the instrument', () => {
    const midi = new Midi();
    midi.header.setTempo(120);
    const track = midi.addTrack();
    track.channel = 9;
    track.addNote({ midi: 36, time: 0, duration: 0.1, velocity: 0.8 });
    const gm = planMidiImport(importMidi(midi.toArray()), 'rhythm');
    expect(gm.drums[0]?.tuneSemitones).toBeUndefined();
  });
});

describe('7: a narrow pitched range', () => {
  it('does not claim three adjacent notes are a kick, a snare and a hat', () => {
    // They get three kit slots so they can be told apart by ear, and that is a
    // playback assignment. What matters is that the identity is the note.
    const midi = new Midi();
    midi.header.setTempo(120);
    const track = midi.addTrack();
    track.channel = 0;
    for (const [index, note] of [60, 61, 62].entries()) {
      track.addNote({ midi: note, time: index * 0.25, duration: 0.1, velocity: 0.8 });
    }
    const plan = planMidiImport(importMidi(midi.toArray()), 'rhythm');
    expect(plan.drums.map(drumVoiceOf)).toEqual(['pitch:60', 'pitch:61', 'pitch:62']);
    expect(plan.drums.map((event) => event.sourcePitch)).toEqual([60, 61, 62]);
  });
});

describe('8: syncopation', () => {
  it('is tightened, not erased', () => {
    // Off-beat hits must still be off-beat afterwards. Quantization pulls them
    // toward the nearest subdivision, not onto the downbeat.
    const offbeats = [0.125, 0.375, 0.625, 0.875].map((t) => hit(62, t + 0.02, 90));
    const out = correct(offbeats, RETOUCH_AMOUNT_DEFAULT).drums.sort(
      (a, b) => a.timeSec - b.timeSec,
    );
    expect(out).toHaveLength(4);
    for (const [index, event] of out.entries()) {
      const nearestBeat = Math.round(event.timeSec / 0.5) * 0.5;
      expect(Math.abs(event.timeSec - nearestBeat), `event ${index}`).toBeGreaterThan(0.05);
    }
  });
});

describe('9: velocity accents', () => {
  it('survive correction', () => {
    const accented = [hit(62, 0, 110), hit(62, 0.5, 45), hit(62, 1, 110), hit(62, 1.5, 45)];
    const out = correct(accented, 100).drums.sort((a, b) => a.timeSec - b.timeSec);
    expect(out.map((event) => event.velocity)).toEqual([110, 45, 110, 45]);
  });
});

describe('10: a triplet subdivision', () => {
  it('keeps all three hits of each triplet', () => {
    // A straight grid cannot represent a triplet, so quantization will move
    // them. What it must not do is decide two of the three were the same hit.
    const beat = 0.5;
    const triplets = [0, 1, 2, 3, 4, 5].map((index) => hit(62, (index * beat) / 3, 90));
    for (const amount of [0, RETOUCH_AMOUNT_DEFAULT, 100]) {
      const out = correct(triplets, amount).drums;
      expect(out, `amount ${amount}`).toHaveLength(6);
      const times = out.map((event) => event.timeSec).sort((a, b) => a - b);
      for (let index = 1; index < times.length; index += 1) {
        expect((times[index] as number) - (times[index - 1] as number)).toBeGreaterThan(0.02);
      }
    }
  });
});

describe('the fidelity measurement itself', () => {
  it('pairs hits by identity and position, not by proximity', () => {
    // A rhythm repeats, so "the nearest hit of this voice" is usually the next
    // one rather than the same one. Measured that way, a pattern that did not
    // move at all reports half a second of drift.
    const source = [hit(62, 0, 90), hit(62, 0.5, 90), hit(62, 1, 90)];
    const metrics = measureRhythmFidelity(source, source.map((event) => ({ ...event })));
    expect(metrics.maxOnsetErrorSec).toBe(0);
    expect(metrics.eventRetention).toBe(1);
  });

  it('reports a lost layer as lost', () => {
    const source = [hit(62, 0, 90), hit(69, 0, 90)];
    const metrics = measureRhythmFidelity(source, [source[0] as DrumEvent]);
    expect(metrics.eventRetention).toBe(0.5);
    expect(metrics.deletedEvents).toBe(1);
    expect(metrics.voiceRetention).toBe(0.5);
    expect(metrics.simultaneityRetention).toBe(0);
  });

  it('reports a broken simultaneous group as broken', () => {
    const source = [hit(62, 1, 90), hit(69, 1, 90)];
    const pulled = [hit(62, 1, 90), hit(69, 1.2, 90)];
    expect(measureRhythmFidelity(source, pulled).simultaneityRetention).toBe(0);
    expect(measureRhythmFidelity(source, pulled).eventRetention).toBe(1);
  });
});
