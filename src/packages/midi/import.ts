/** Standard MIDI File import into Rhythmisoze's stable event contracts. */

import { Midi } from '@tonejs/midi';
import {
  AppError,
  BPM_MAX,
  BPM_MIN,
  DEFAULT_METER,
  type CreationMode,
  type DrumClass,
  type DrumEvent,
  type Meter,
  type NoteEvent,
} from '@contracts';

const GM_DRUM_CHANNEL = 9;

export interface MidiImportResult {
  /**
   * Everything not on the General MIDI percussion channel.
   *
   * "Not on channel 10" is a statement about encoding, not about music. A
   * rhythm exported from a drum machine or a DAW's pitched sampler arrives here
   * — see `interpretNotesAsRhythm` for reading it as what it is.
   */
  notes: NoteEvent[];
  /** Events the file itself declared as percussion, by putting them on channel 10. */
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

/**
 * Reading pitched MIDI notes as rhythmic hits.
 *
 * ## Why this exists
 *
 * The importer classifies percussion by MIDI channel, because that is what the
 * General MIDI specification says channel 10 means. What it does not mean is
 * that everything *else* is a melody. A user exported a rhythm from another
 * application, which wrote it as ordinary pitched notes on channel 1, and
 * Rhythmisoze concluded from the absence of channel 10 that the user's rhythm
 * was actually a tune — 145 percussive events routed into a melodic pipeline.
 *
 * Channel assignment is a convention of the file format. The mode is a decision
 * the person made. When they disagree, the person is right, and this is how the
 * file is read into what they asked for.
 *
 * ## How pitches become classes
 *
 * By rank within the file's own set of distinct pitches, split three ways:
 * lowest third to kick, middle to snare, highest to hat. Register order is how
 * percussion is laid out everywhere from a drum kit to General MIDI's own note
 * map to a sampler's pads, so this is the convention the file was almost
 * certainly written against.
 *
 * By *rank* rather than by absolute pitch so that a file using a narrow range
 * still separates its voices — the real one uses fifteen pitches from 43 to 81,
 * and its three main layers at 62, 69 and 74 land in three different classes,
 * which is what keeps the pattern audible rather than flattening it.
 *
 * Nothing is thrown away: `sourcePitch` keeps the note the file actually
 * contained, so the mapping is a reading rather than a replacement.
 */
export function interpretNotesAsRhythm(notes: readonly NoteEvent[]): DrumEvent[] {
  if (notes.length === 0) return [];
  const distinct = [...new Set(notes.map((note) => note.pitch))].sort((a, b) => a - b);
  const third = distinct.length / 3;

  return notes
    .map((note) => {
      const rank = distinct.indexOf(note.pitch);
      const drum: DrumClass = rank < third ? 'kick' : rank < 2 * third ? 'snare' : 'hat';
      return {
        timeSec: note.startSec,
        drum,
        velocity: note.velocity,
        // The file said so. There is no detector here whose confidence could be
        // anything else, and pretending otherwise would understate the evidence.
        confidence: 1,
        sourcePitch: note.pitch,
      };
    })
    .sort((a, b) => a.timeSec - b.timeSec || (a.sourcePitch ?? 0) - (b.sourcePitch ?? 0));
}

/**
 * How an imported file should be read, given the mode the user is in.
 *
 * Pure, and separate from the hook, because this is the decision that went
 * wrong: the rule was three lines of ternary inside an async upload handler,
 * where it could not be tested and nobody looked at it again.
 */
export interface MidiImportPlan {
  /** The mode the creation should be in after the import. */
  mode: CreationMode;
  /** Melodic material, empty in Rhythm mode. */
  notes: NoteEvent[];
  /** Rhythmic material: the file's own percussion, plus pitched notes read as hits. */
  drums: DrumEvent[];
  /** How many pitched notes were read as rhythm. Zero unless that happened. */
  pitchedNotesAsRhythm: number;
  /** Set when the file had nothing the selected mode could use. */
  modeChangedBecause: 'percussion-only' | null;
}

/**
 * ## The rule
 *
 * ```
 * selected  file has            ->  result
 * rhythm    percussion          ->  rhythm, as percussion
 * rhythm    pitched notes       ->  rhythm, pitched notes read as hits
 * rhythm    both                ->  rhythm, both
 * melody    pitched notes       ->  melody
 * melody    both                ->  melody, the pitched part
 * melody    percussion only     ->  rhythm, and it says so
 * ```
 *
 * ## Why only one cell changes the mode
 *
 * The old rule changed it in two, and the second one was a category error:
 * *no percussion channel, therefore not a rhythm*. Channel 10 is a convention
 * of the file format. Its absence says nothing whatever about what the music
 * is, and a rhythm exported from another application as pitched notes on
 * channel 1 is an ordinary thing to receive. Reading that as "the user was
 * wrong about their own take" sent 145 percussive events into the melodic
 * pipeline.
 *
 * The remaining cell is not the same kind of inference. General MIDI note
 * numbers on channel 10 name instruments — 36 is a bass drum, not a C2 — so a
 * percussion-only file has no melodic content to offer at all. Changing mode
 * there is not overruling a preference, it is the only reading that exists, and
 * `modeChangedBecause` records it so the app can say so rather than doing it
 * quietly.
 */
export function planMidiImport(
  result: MidiImportResult,
  selectedMode: CreationMode,
): MidiImportPlan {
  const percussionOnly = result.notes.length === 0 && result.drums.length > 0;
  const mode: CreationMode = selectedMode === 'melody' && percussionOnly ? 'rhythm' : selectedMode;

  if (mode !== 'rhythm') {
    return {
      mode,
      notes: result.notes,
      drums: [],
      pitchedNotesAsRhythm: 0,
      modeChangedBecause: null,
    };
  }

  const fromPitches = interpretNotesAsRhythm(result.notes);
  return {
    mode,
    notes: [],
    drums: [...result.drums, ...fromPitches].sort((a, b) => a.timeSec - b.timeSec),
    pitchedNotesAsRhythm: fromPitches.length,
    modeChangedBecause: mode === selectedMode ? null : 'percussion-only',
  };
}
