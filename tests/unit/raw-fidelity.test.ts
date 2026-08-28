/**
 * Does the app hand back the transcription it was given?
 *
 * Both properties here were broken at once, and together they made a correct
 * GAME transcription arrive as a wrong one. The notes were never the problem,
 * which is exactly why it took so long to find: the pitches matched, so the
 * pipeline looked innocent while the timing and the note count did not survive
 * it.
 *
 * The fixtures are built to look like GAME's real output rather than like
 * convenient test data. That means one thing above all: **the notes touch**.
 * A transcriber describes a held or re-articulated tone as a run of adjacent
 * notes whose start is the previous note's end, and on a real 30 s take 124 of
 * 128 neighbouring pairs were exactly contiguous. Test material with tidy gaps
 * between notes would have passed both bugs.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import { melodyToMidi } from '@midi';
import { mergeShortNotes } from '@/packages/retouch/extensions';
import { resolveRetouchParams, stepSeconds } from '@/packages/retouch/macro';

/** A GAME-shaped chain: every note starts exactly where the previous one ended. */
function contiguousChain(pitches: readonly number[], startSec = 0.59, stepSec = 0.19): NoteEvent[] {
  return pitches.map((pitch, index) => ({
    startSec: startSec + index * stepSec,
    endSec: startSec + (index + 1) * stepSec,
    pitch,
    velocity: 96,
  }));
}

/** Onsets in seconds, read back through whatever tempo map the file declares. */
function onsetsOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 10;
  const trackCount = view.getUint16(at, false);
  at += 2;
  const ppq = view.getUint16(at, false);
  at += 2;

  const events: Array<{ tick: number; kind: number; tempo?: number }> = [];
  for (let track = 0; track < trackCount; track += 1) {
    at += 4;
    const end = at + 4 + view.getUint32(at, false);
    at += 4;
    let tick = 0;
    let status = 0;
    while (at < end) {
      let delta = 0;
      for (;;) {
        const byte = view.getUint8(at);
        at += 1;
        delta = (delta << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
      }
      tick += delta;
      const peek = view.getUint8(at);
      if (peek & 0x80) {
        status = peek;
        at += 1;
      }
      if (status === 0xff) {
        const type = view.getUint8(at);
        at += 1;
        let length = 0;
        for (;;) {
          const byte = view.getUint8(at);
          at += 1;
          length = (length << 7) | (byte & 0x7f);
          if ((byte & 0x80) === 0) break;
        }
        if (type === 0x51) {
          events.push({
            tick,
            kind: 2,
            tempo: (view.getUint8(at) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at + 2),
          });
        }
        at += length;
        continue;
      }
      const high = status & 0xf0;
      const velocity = view.getUint8(at + 1);
      at += high === 0xc0 || high === 0xd0 ? 1 : 2;
      if (high === 0x90 && velocity > 0) events.push({ tick, kind: 1 });
    }
    at = end;
  }

  events.sort((a, b) => a.tick - b.tick || a.kind - b.kind);
  let tempo = 500_000;
  let lastTick = 0;
  let clock = 0;
  const onsets: number[] = [];
  for (const event of events) {
    clock += ((event.tick - lastTick) * tempo) / (ppq * 1e6);
    lastTick = event.tick;
    if (event.kind === 2) tempo = event.tempo as number;
    else onsets.push(clock);
  }
  return onsets;
}

describe('exported MIDI keeps the transcription on its own clock', () => {
  const notes = contiguousChain([56, 56, 55, 56, 57, 57, 58, 57, 55, 54]);

  const exportAt = (bpm: number): Uint8Array =>
    melodyToMidi(notes, {
      bpm,
      meter: { beatsPerBar: 4, beatUnit: 4 },
      title: 'take',
      program: 0,
    });

  it('places notes at the seconds they were transcribed at', () => {
    // 100 is `encodingBpm` for a freely timed take, which is the ordinary hum.
    // Ticks were computed at a hard-coded 120 while the header declared 100, so
    // every onset and duration came out 20% long. On a 30 s recording the last
    // note landed almost four seconds past the end of the audio.
    const onsets = onsetsOf(exportAt(100));

    expect(onsets).toHaveLength(notes.length);
    for (const [index, note] of notes.entries()) {
      expect(onsets[index]).toBeCloseTo(note.startSec, 3);
    }
  });

  it('places them there at every tempo, not only at 120', () => {
    // The stretch was `120 / options.bpm`, so the one tempo that looked correct
    // was the one the constant happened to be. Tolerance is one tick — the
    // residual here is the tick grid itself, which is as exact as SMF gets.
    for (const bpm of [60, 83.5, 100, 120, 140]) {
      const onsets = onsetsOf(exportAt(bpm));
      const tickSec = 60 / (480 * bpm);
      expect(onsets[0]).toBeCloseTo(notes[0]?.startSec ?? 0, 2);
      expect(Math.abs((onsets.at(-1) as number) - (notes.at(-1) as NoteEvent).startSec)).
        toBeLessThanOrEqual(tickSec);
    }
  });

  it('survives a tempo that cannot be used as a divisor', () => {
    // A zero or missing tempo must not put every note at tick 0, and the
    // fallback has to be the same on both sides or the clocks part again.
    for (const bpm of [0, Number.NaN, -30]) {
      const onsets = onsetsOf(exportAt(bpm));
      expect(onsets).toHaveLength(notes.length);
      for (const [index, note] of notes.entries()) {
        expect(onsets[index]).toBeCloseTo(note.startSec, 2);
      }
    }
  });
});

describe('the unprocessed version changes nothing', () => {
  // Its documented job: "the transcription exactly as it arrived ... the
  // reference point everything else is judged against."
  const notes = contiguousChain([56, 56, 56, 55, 56, 56, 57, 57, 57, 58, 58, 55]);

  function merge(amount: number): ReturnType<typeof mergeShortNotes> {
    const params = resolveRetouchParams(amount);
    return mergeShortNotes(notes, {
      minDurationSec: params.mergeMinDurationSec,
      maxGapSec: params.mergeMaxGapSec,
      stepSec: stepSeconds(100, params.grid),
    });
  }

  it('keeps every note when no fusing was asked for', () => {
    // `maxGapSec` is 0 at amount 0, and the test was `<= gap`. Touching notes
    // have a gap of exactly 0, so every same-pitch neighbour fused: a real
    // transcription lost 47% of its notes at the setting that must not change
    // anything.
    const result = merge(0);

    expect(result.notes).toHaveLength(notes.length);
    expect(result.merged).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.notes.map((note) => note.startSec)).toEqual(notes.map((note) => note.startSec));
    expect(result.notes.map((note) => note.endSec)).toEqual(notes.map((note) => note.endSec));
  });

  it('still fuses re-articulations once fusing is asked for', () => {
    // The feature itself is not the bug and must survive the fix.
    const result = merge(100);

    expect(result.merged).toBeGreaterThan(0);
    expect(result.notes.length).toBeLessThan(notes.length);
    // Fusing joins same-pitch neighbours; it never invents a pitch.
    expect(new Set(result.notes.map((note) => note.pitch))).toEqual(
      new Set(notes.map((note) => note.pitch)),
    );
  });

  it('leaves a rest alone even when fusing hard', () => {
    const withRest: NoteEvent[] = [
      { startSec: 0, endSec: 0.4, pitch: 60, velocity: 96 },
      { startSec: 2.0, endSec: 2.4, pitch: 60, velocity: 96 },
    ];
    const params = resolveRetouchParams(100);
    const result = mergeShortNotes(withRest, {
      minDurationSec: params.mergeMinDurationSec,
      maxGapSec: params.mergeMaxGapSec,
      stepSec: stepSeconds(100, params.grid),
    });

    expect(result.notes).toHaveLength(2);
  });
});
