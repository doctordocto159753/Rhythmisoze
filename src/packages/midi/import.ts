/** Standard MIDI File import into Rhythmisoze's stable event contracts. */

import { Midi } from '@tonejs/midi';
import {
  AppError,
  BPM_MAX,
  BPM_MIN,
  DEFAULT_METER,
  type DrumClass,
  type DrumEvent,
  type Meter,
  type NoteEvent,
} from '@contracts';

const GM_DRUM_CHANNEL = 9;

export interface MidiImportResult {
  notes: NoteEvent[];
  drums: DrumEvent[];
  bpm: number;
  meter: Meter;
  durationSec: number;
  trackCount: number;
}

export function importMidi(data: Uint8Array): MidiImportResult {
  let midi: Midi;
  try {
    midi = new Midi(data);
  } catch (error) {
    throw new AppError('midi_invalid', 'retry', 'parse failed', { cause: error });
  }

  const notes: NoteEvent[] = [];
  const drums: DrumEvent[] = [];

  for (const track of midi.tracks) {
    const percussion = track.channel === GM_DRUM_CHANNEL;
    for (const note of track.notes) {
      const startSec = Math.max(0, note.time);
      const endSec = Math.max(startSec + 0.01, startSec + note.duration);
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
      if (percussion) {
        drums.push({
          timeSec: startSec,
          drum: gmDrumClass(note.midi),
          velocity,
          confidence: 1,
        });
      } else {
        notes.push({
          startSec,
          endSec,
          pitch: Math.max(0, Math.min(127, Math.round(note.midi))),
          velocity,
          confidence: 1,
        });
      }
    }
  }

  notes.sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
  drums.sort((a, b) => a.timeSec - b.timeSec);
  if (notes.length === 0 && drums.length === 0) {
    throw new AppError('midi_empty', 'retry', 'no note events');
  }

  const tempo = midi.header.tempos[0]?.bpm ?? 100;
  const signature = midi.header.timeSignatures[0]?.timeSignature;
  const beatsPerBar = signature?.[0];
  const beatUnit = signature?.[1];
  const meter: Meter =
    beatsPerBar !== undefined && (beatUnit === 2 || beatUnit === 4 || beatUnit === 8)
      ? { beatsPerBar: Math.max(1, Math.round(beatsPerBar)), beatUnit }
      : DEFAULT_METER;
  const eventDuration = Math.max(
    0,
    ...notes.map((note) => note.endSec),
    ...drums.map((drum) => drum.timeSec + 0.125),
  );

  return {
    notes,
    drums,
    bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(tempo))),
    meter,
    durationSec: Math.max(eventDuration, midi.duration),
    trackCount: midi.tracks.length,
  };
}

function gmDrumClass(note: number): DrumClass {
  if ([35, 36].includes(note)) return 'kick';
  if ([37, 38, 39, 40].includes(note)) return 'snare';
  if ([42, 44, 46].includes(note)) return 'hat';
  return 'unknown';
}
