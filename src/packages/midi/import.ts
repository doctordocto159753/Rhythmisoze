/** Standard MIDI File import into Rhythmisoze's stable event contracts. */

import { Midi } from '@tonejs/midi';
import {
  AppError,
  BPM_MAX,
  BPM_MIN,
  DEFAULT_METER,
  GM_DRUM_CHANNEL,
  type CreationMode,
  type DrumClass,
  type DrumEvent,
  type InputClassification,
  type JudgeVerdict,
  type Meter,
  type NoteEvent,
} from '@contracts';
import { classifyMidiInput } from '@intent';

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
          // General MIDI note numbers name instruments, so the number *is* the
          // identity and the app's three-slot kit is a coarser rendering of it.
          // A side stick and a snare are both played through `snare`; they are
          // not the same part, and nothing downstream may treat them as one.
          voice: `gm:${Math.round(note.midi)}`,
          sourcePitch: Math.round(note.midi),
          sourceChannel: GM_DRUM_CHANNEL,
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
 * Channel assignment is a convention of the file format. Structural evidence
 * can recommend a rhythmic reading, and the post-review correction can request
 * one explicitly. This adapter performs that reading without erasing source
 * identity.
 *
 * ## What is identity here, and what is only a sound
 *
 * A pitched-channel file says nothing about drums. Pitch 43 is not a kick; it
 * is the forty-third note, used by whoever made the file to mean whatever they
 * meant. So **the note number is the voice**, and every distinct pitch stays a
 * distinct rhythmic layer for the whole of the pipeline.
 *
 * `drum` is separate and is only a *playback assignment*: the synthesised kit
 * has three slots and this file has fifteen layers, so several layers share a
 * sound. They are assigned by rank within the file's own pitch set — low third,
 * middle, high — which is how percussion is laid out from a drum kit to a
 * sampler's pads, and is therefore the least surprising rendering of an unknown
 * mapping. It is a guess about how it should *sound*, and it is allowed to be a
 * guess because nothing musical is decided by it.
 *
 * That separation is the whole point. When the two were one field, "these hits
 * are both snare-ish" and "these hits are the same part" were the same
 * statement, and the quantizer deleted one of every pair.
 */
/** Beyond this a tuned hit stops sounding like the drum it was assigned to. */
const MAX_HIT_TUNE_SEMITONES = 7;

export function interpretNotesAsRhythm(notes: readonly NoteEvent[]): DrumEvent[] {
  if (notes.length === 0) return [];
  const distinct = [...new Set(notes.map((note) => note.pitch))].sort((a, b) => a - b);
  const third = distinct.length / 3;

  // Each slot's own centre, so a layer can be tuned away from it and still be
  // heard as that part of the kit rather than as a different instrument.
  const slotOf = (pitch: number): DrumClass => {
    const rank = distinct.indexOf(pitch);
    return rank < third ? 'kick' : rank < 2 * third ? 'snare' : 'hat';
  };
  const slotCentres = new Map<DrumClass, number>();
  for (const slot of ['kick', 'snare', 'hat'] as const) {
    const members = distinct.filter((pitch) => slotOf(pitch) === slot);
    if (members.length > 0) {
      slotCentres.set(slot, members[Math.floor(members.length / 2)] as number);
    }
  }

  return notes
    .map((note) => {
      const drum = slotOf(note.pitch);
      // Bounded, because a kick tuned two octaves up is not a kick any more.
      // Inside the bound the layers stay distinct and the kit stays a kit.
      const tuneSemitones = Math.max(
        -MAX_HIT_TUNE_SEMITONES,
        Math.min(MAX_HIT_TUNE_SEMITONES, note.pitch - (slotCentres.get(drum) ?? note.pitch)),
      );
      return {
        timeSec: note.startSec,
        // How it sounds, and how far from that sound's centre.
        drum,
        tuneSemitones,
        // What it is. Two layers may share the lines above; they never share this.
        voice: `pitch:${note.pitch}`,
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
 * How an imported file should be read from structural evidence.
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
  /** Internal routing decision, absent only from no path in current code. */
  classification: InputClassification;
  /** Source-faithful symbolic Judge result for pitched material. */
  judge: JudgeVerdict | null;
}

/**
 * Automatic routing is preservation-first: declared GM percussion remains
 * percussion; structurally rhythmic pitched notes can become hits; ambiguous
 * all-pitched material keeps both readings. `selectedMode` is retained only as
 * a compatibility/correction adapter for saved callers and the Review escape
 * hatch. The creation screen never asks for it up front.
 */
export function planMidiImport(
  result: MidiImportResult,
  selectedMode?: CreationMode,
): MidiImportPlan {
  const classification = classifyMidiInput(result);

  // Compatibility adapter for callers that still pass the saved legacy mode.
  // The creation UI no longer calls this branch, but keeping it means old
  // integrations preserve their exact interpretation while projects migrate.
  if (selectedMode !== undefined) return planLegacyMidiImport(result, selectedMode, classification);

  if (classification.type === 'rhythm') {
    const fromPitches = interpretNotesAsRhythm(result.notes);
    return {
      mode: 'rhythm',
      notes: [],
      drums: [...result.drums, ...fromPitches].sort((a, b) => a.timeSec - b.timeSec),
      pitchedNotesAsRhythm: fromPitches.length,
      modeChangedBecause: null,
      classification,
      judge: null,
    };
  }

  if (classification.type === 'mixed') {
    // Mixed is the preservation route, not a licence to guess which pitched
    // events are disposable. A declared drum channel already separates the
    // streams. For ambiguous all-pitched material we keep every note *and* add
    // a rhythmic reading beside it; correction in Review can later choose one.
    const fromPitches = result.drums.length > 0 ? [] : interpretNotesAsRhythm(result.notes);
    return {
      // Kept in the persisted v3 vocabulary; `classification.type` carries the
      // richer internal truth without changing saved-project schemas.
      mode: 'melody',
      notes: result.notes,
      drums: [...result.drums, ...fromPitches].sort((a, b) => a.timeSec - b.timeSec),
      pitchedNotesAsRhythm: fromPitches.length,
      modeChangedBecause: null,
      classification,
      judge: symbolicJudge(result.notes),
    };
  }

  return {
    mode: 'melody',
    notes: result.notes,
    drums: [],
    pitchedNotesAsRhythm: 0,
    modeChangedBecause: null,
    classification,
    judge: symbolicJudge(result.notes),
  };
}

function planLegacyMidiImport(
  result: MidiImportResult,
  selectedMode: CreationMode,
  classification: InputClassification,
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
      classification,
      judge: symbolicJudge(result.notes),
    };
  }

  const fromPitches = interpretNotesAsRhythm(result.notes);
  return {
    mode,
    notes: [],
    drums: [...result.drums, ...fromPitches].sort((a, b) => a.timeSec - b.timeSec),
    pitchedNotesAsRhythm: fromPitches.length,
    modeChangedBecause: mode === selectedMode ? null : 'percussion-only',
    classification,
    judge: null,
  };
}

function symbolicJudge(notes: readonly NoteEvent[]): JudgeVerdict | null {
  if (notes.length === 0) return null;
  return {
    notes: notes.map((note) => ({ ...note })),
    score: 1,
    scoreBefore: 1,
    repairs: [],
    unsupportedNotesRemoved: 0,
    octaveErrorsCorrected: 0,
  };
}
