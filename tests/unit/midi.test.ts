/**
 * US-0901 / US-0505 - MIDI export and filename safety.
 *
 * Every assertion parses the bytes back rather than trusting the writer, which
 * is the only way to know the file a user downloads says what it should.
 */

import { describe, expect, it } from 'vitest';
import type { DrumEvent, NoteEvent } from '@contracts';
import { GM_DRUM_MAP } from '@contracts';
import {
  drumToGmNote,
  melodyToMidi,
  parseMidi,
  rhythmToMidi,
  toSafeFilename,
  toSafeFilenameStem,
  MAX_FILENAME_STEM_LENGTH,
} from '@midi';

const METER = { beatsPerBar: 4, beatUnit: 4 } as const;

const NOTES: NoteEvent[] = [
  { startSec: 0, endSec: 0.5, pitch: 60, velocity: 100 },
  { startSec: 0.5, endSec: 1, pitch: 64, velocity: 80 },
  { startSec: 1, endSec: 2, pitch: 67, velocity: 120 },
];

const DRUMS: DrumEvent[] = [
  { timeSec: 0, drum: 'kick', velocity: 110, confidence: 0.9 },
  { timeSec: 0.25, drum: 'hat', velocity: 60, confidence: 0.8 },
  { timeSec: 0.5, drum: 'snare', velocity: 100, confidence: 0.85 },
  { timeSec: 0.75, drum: 'unknown', velocity: 70, confidence: 0.3 },
];

describe('melodyToMidi', () => {
  const bytes = melodyToMidi(NOTES, { bpm: 120, meter: METER, title: 'Test', program: 24 });
  const midi = parseMidi(bytes);

  it('writes a header chunk a parser accepts', () => {
    expect(bytes.length).toBeGreaterThan(20);
    expect([...bytes.slice(0, 4)]).toEqual([0x4d, 0x54, 0x68, 0x64]); // "MThd"
  });

  it('carries the tapped tempo, not a default', () => {
    expect(midi.header.tempos[0]?.bpm).toBeCloseTo(120, 3);
  });

  it('carries the selected time signature', () => {
    expect(midi.header.timeSignatures[0]?.timeSignature).toEqual([4, 4]);
  });

  it('writes every note at the right pitch and time', () => {
    const track = midi.tracks[0];
    expect(track?.notes).toHaveLength(3);
    expect(track?.notes.map((n) => n.midi)).toEqual([60, 64, 67]);
    track?.notes.forEach((note, index) => {
      expect(note.time).toBeCloseTo((NOTES[index] as NoteEvent).startSec, 2);
      expect(note.duration).toBeCloseTo(
        (NOTES[index] as NoteEvent).endSec - (NOTES[index] as NoteEvent).startSec,
        2,
      );
    });
  });

  it('carries the instrument program', () => {
    expect(midi.tracks[0]?.instrument.number).toBe(24);
  });

  it('preserves relative velocity', () => {
    const velocities = midi.tracks[0]?.notes.map((n) => n.velocity) ?? [];
    expect(velocities[2]).toBeGreaterThan(velocities[1] as number);
  });

  it('clamps out-of-range values rather than writing a corrupt file', () => {
    const extreme = melodyToMidi(
      [{ startSec: -5, endSec: 1, pitch: 999, velocity: 999 }],
      { bpm: 90, meter: METER, title: 'x', program: 999 },
    );
    const note = parseMidi(extreme).tracks[0]?.notes[0];
    expect(note?.midi).toBe(127);
    expect(note?.time).toBeGreaterThanOrEqual(0);
  });

  it('produces an empty but valid file for an empty sketch', () => {
    const empty = melodyToMidi([], { bpm: 90, meter: METER, title: 'x', program: 0 });
    expect(parseMidi(empty).tracks[0]?.notes ?? []).toHaveLength(0);
  });
});

describe('rhythmToMidi', () => {
  const bytes = rhythmToMidi(DRUMS, { bpm: 120, meter: METER, title: 'Beat', program: 0 });
  const midi = parseMidi(bytes);

  it('writes on the General MIDI percussion channel', () => {
    expect(midi.tracks[0]?.channel).toBe(9);
  });

  it('maps each class to its documented GM note', () => {
    expect(midi.tracks[0]?.notes.map((n) => n.midi)).toEqual([
      GM_DRUM_MAP.kick,
      GM_DRUM_MAP.hat,
      GM_DRUM_MAP.snare,
      // `unknown` is voiced, not dropped.
      GM_DRUM_MAP.hat,
    ]);
  });

  it('agrees with the playback mapping helper', () => {
    expect(drumToGmNote('kick')).toBe(36);
    expect(drumToGmNote('snare')).toBe(38);
    expect(drumToGmNote('hat')).toBe(42);
    expect(drumToGmNote('unknown')).toBe(42);
  });

  it('keeps every hit', () => {
    expect(midi.tracks[0]?.notes).toHaveLength(DRUMS.length);
  });
});

describe('filename safety (US-0901)', () => {
  it('keeps a Persian title intact', () => {
    expect(toSafeFilenameStem('شب بارانی')).toBe('شب بارانی');
  });

  it('keeps an English title intact', () => {
    expect(toSafeFilenameStem('Morning hum')).toBe('Morning hum');
  });

  it('removes characters that break a filesystem', () => {
    expect(toSafeFilenameStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('strips bidi controls that could disguise the extension', () => {
    const spoofed = `song‮dim.mid`;
    expect(toSafeFilenameStem(spoofed)).not.toContain('‮');
  });

  it('refuses to end in a dot or space, which Windows cannot address', () => {
    expect(toSafeFilenameStem('sketch...')).toBe('sketch');
    expect(toSafeFilenameStem('sketch   ')).toBe('sketch');
  });

  it('escapes reserved Windows device names', () => {
    expect(toSafeFilenameStem('CON')).toBe('CON-sketch');
    expect(toSafeFilenameStem('nul')).toBe('nul-sketch');
  });

  it('never returns an empty stem', () => {
    expect(toSafeFilenameStem('///')).toBe('rhythmisoze-sketch');
    expect(toSafeFilenameStem('')).toBe('rhythmisoze-sketch');
  });

  it('bounds the length', () => {
    expect(toSafeFilenameStem('x'.repeat(500)).length).toBeLessThanOrEqual(
      MAX_FILENAME_STEM_LENGTH,
    );
  });

  it('appends the right extension', () => {
    expect(toSafeFilename('ایده', 'mid')).toBe('ایده.mid');
    expect(toSafeFilename('idea', 'wav')).toBe('idea.wav');
  });
});
