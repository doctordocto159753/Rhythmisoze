/**
 * US-0901 / US-0505 - Standard MIDI File export.
 *
 * ## Documented mapping
 *
 * **Melody** - one track, channel 1, General MIDI program taken from the chosen
 * instrument's registry entry. Notes carry their retouched time, pitch and
 * velocity, in seconds, converted by `@tonejs/midi` against the file tempo.
 *
 * **Rhythm** - one track on channel 10, the GM percussion channel, with
 * `kick -> 36`, `snare -> 38`, `hat -> 42`. An `unknown` stroke is voiced as a
 * closed hat rather than dropped, so the exported file and the in-app playback
 * agree note for note (US-0505 acceptance criterion).
 *
 * The file's tempo is the BPM the user tapped, so opening it in a DAW lands the
 * notes on that DAW's grid rather than somewhere near it.
 */

import { Midi } from '@tonejs/midi';
import {
  GM_DRUM_MAP,
  UNKNOWN_DRUM_FALLBACK,
  type DrumEvent,
  type Meter,
  type NoteEvent,
} from '@contracts';

export interface MidiExportOptions {
  bpm: number;
  meter: Meter;
  title: string;
  /** General MIDI program number, 0..127. Ignored for the rhythm track. */
  program: number;
  instrumentName?: string;
}

/** GM percussion lives on channel 10, which is index 9. */
const GM_DRUM_CHANNEL = 9;

export function melodyToMidi(notes: readonly NoteEvent[], options: MidiExportOptions): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(options.bpm);
  midi.header.timeSignatures.push({
    ticks: 0,
    timeSignature: [options.meter.beatsPerBar, options.meter.beatUnit],
  });
  midi.header.name = options.title;

  const track = midi.addTrack();
  track.name = options.instrumentName ?? options.title;
  track.channel = 0;
  track.instrument.number = clampProgram(options.program);

  for (const note of notes) {
    track.addNote({
      midi: clampPitch(note.pitch),
      time: Math.max(0, note.startSec),
      duration: Math.max(0.01, note.endSec - note.startSec),
      velocity: clampVelocity(note.velocity) / 127,
    });
  }

  return midi.toArray();
}

export function rhythmToMidi(drums: readonly DrumEvent[], options: MidiExportOptions): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(options.bpm);
  midi.header.timeSignatures.push({
    ticks: 0,
    timeSignature: [options.meter.beatsPerBar, options.meter.beatUnit],
  });
  midi.header.name = options.title;

  const track = midi.addTrack();
  track.name = options.instrumentName ?? 'Drums';
  track.channel = GM_DRUM_CHANNEL;

  for (const event of drums) {
    track.addNote({
      midi: drumToGmNote(event.drum),
      time: Math.max(0, event.timeSec),
      // Percussion is one-shot; the note length only has to be non-zero for a
      // sequencer to draw it. An eighth of a second reads clearly in a piano roll.
      duration: 0.125,
      velocity: clampVelocity(event.velocity) / 127,
    });
  }

  return midi.toArray();
}

export function drumToGmNote(drum: DrumEvent['drum']): number {
  const resolved = drum === 'unknown' ? UNKNOWN_DRUM_FALLBACK : drum;
  // UNKNOWN_DRUM_FALLBACK is itself typed as DrumClass, so narrow once here
  // rather than letting every call site deal with it.
  return GM_DRUM_MAP[resolved as Exclude<DrumEvent['drum'], 'unknown'>];
}

function clampProgram(program: number): number {
  return Math.max(0, Math.min(127, Math.round(program)));
}

function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

function clampVelocity(velocity: number): number {
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

/** Reads a file back. Used by the export tests to prove what was written. */
export function parseMidi(data: Uint8Array): Midi {
  return new Midi(data);
}
