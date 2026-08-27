/** Standard MIDI File import into Rhythmisoze's stable event contracts. */

import { parseMidi as parseSmf, type MidiEvent } from 'midi-file';
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
  type RawNoteEvent,
  type RawMidiTempoEvent,
  type RawMidiTimeSignatureEvent,
  type RawTranscription,
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
  /** Complete immutable canonical Raw value, including source MIDI timing identity. */
  rawTranscription: RawTranscription;
}

export function importMidi(data: Uint8Array): MidiImportResult {
  let parsed: ReturnType<typeof parseSmf>;
  try {
    parsed = parseSmf(data);
  } catch (error) {
    throw new AppError('midi_invalid', 'retry', 'parse failed', { cause: error });
  }

  const canonical = parseCanonicalEvents(parsed);
  const notes: NoteEvent[] = [];
  const drums: DrumEvent[] = [];
  for (const raw of canonical.notes) {
    const startSec = raw.startSec;
    const endSec = Math.max(startSec + 0.01, raw.endSec);
    const velocity = raw.velocity ?? 96;
    if (raw.sourceChannel === GM_DRUM_CHANNEL) {
        drums.push({
          timeSec: startSec,
          drum: gmDrumClass(raw.pitchMidi),
          // General MIDI note numbers name instruments, so the number *is* the
          // identity and the app's three-slot kit is a coarser rendering of it.
          // A side stick and a snare are both played through `snare`; they are
          // not the same part, and nothing downstream may treat them as one.
          voice: `gm:${Math.round(raw.pitchMidi)}`,
          sourcePitch: Math.round(raw.pitchMidi),
          sourceChannel: GM_DRUM_CHANNEL,
          sourceTrack: raw.sourceTrack,
          sourceOrder: raw.sourceOrder,
          sourceEndSec: endSec,
          sourceStartTicks: raw.sourceStartTicks,
          sourceEndTicks: raw.sourceEndTicks,
          velocity,
          confidence: 1,
        });
    } else {
        const imported: NoteEvent = {
          startSec,
          endSec,
          pitch: raw.pitchMidi,
          velocity,
          confidence: 1,
          sourceTrack: raw.sourceTrack,
          sourceChannel: raw.sourceChannel,
          sourceOrder: raw.sourceOrder,
          sourceStartTicks: raw.sourceStartTicks,
          sourceEndTicks: raw.sourceEndTicks,
        };
        notes.push(imported);
    }
  }

  notes.sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
  drums.sort((a, b) => a.timeSec - b.timeSec);
  if (notes.length === 0 && drums.length === 0) {
    throw new AppError('midi_empty', 'retry', 'no note events');
  }

  const tempo = canonical.tempos[0]?.bpm ?? 120;
  const signature = canonical.timeSignatures[0]?.timeSignature;
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
    durationSec: Math.max(eventDuration, canonical.durationSec),
    trackCount: parsed.header.numTracks,
    rawTranscription: {
      version: 1,
      sourceKind: 'midi',
      notes: canonical.notes,
      drums: drums.map((drum) => ({ ...drum })),
      provenance: {
        source: 'midi',
        transcriber: 'midi-import',
        model: 'standard-midi-file',
        modelVersion: 'smf',
        backend: 'midi-parser',
      },
      sourceDurationSec: Math.max(eventDuration, canonical.durationSec),
      midi: {
        format: parsed.header.format,
        ppq: canonical.ppq,
        trackCount: parsed.header.numTracks,
        tempos: canonical.tempos,
        timeSignatures: canonical.timeSignatures,
      },
    },
  };
}

interface AbsoluteTempo {
  ticks: number;
  microsecondsPerBeat: number;
  sourceTrack: number;
  sourceOrder: number;
}

function parseCanonicalEvents(parsed: ReturnType<typeof parseSmf>): {
  notes: RawNoteEvent[];
  tempos: RawMidiTempoEvent[];
  timeSignatures: RawMidiTimeSignatureEvent[];
  ppq: number;
  durationSec: number;
} {
  const ppq = parsed.header.ticksPerBeat;
  if (!ppq || ppq <= 0) {
    throw new AppError('midi_invalid', 'retry', 'SMPTE time division is not supported');
  }
  const tempos: AbsoluteTempo[] = [];
  const signatures: Array<{
    ticks: number;
    numerator: number;
    denominator: number;
    sourceTrack: number;
    sourceOrder: number;
  }> = [];
  const absoluteTracks: Array<Array<{ event: MidiEvent; ticks: number; order: number }>> = [];
  for (const [sourceTrack, track] of parsed.tracks.entries()) {
    let ticks = 0;
    const absolute = track.map((event, sourceOrder) => {
      ticks += event.deltaTime;
      if (event.type === 'setTempo') {
        tempos.push({ ticks, microsecondsPerBeat: event.microsecondsPerBeat, sourceTrack, sourceOrder });
      } else if (event.type === 'timeSignature') {
        signatures.push({
          ticks,
          numerator: event.numerator,
          denominator: event.denominator,
          sourceTrack,
          sourceOrder,
        });
      }
      return { event, ticks, order: sourceOrder };
    });
    absoluteTracks.push(absolute);
  }

  const sortedTempos = [...tempos].sort(
    (a, b) => a.ticks - b.ticks || a.sourceTrack - b.sourceTrack || a.sourceOrder - b.sourceOrder,
  );
  const tempoClock = (sourceTrack: number): AbsoluteTempo[] =>
    parsed.header.format === 2
      ? sortedTempos.filter((tempo) => tempo.sourceTrack === sourceTrack)
      : sortedTempos;
  const notes: RawNoteEvent[] = [];
  let noteOrder = 0;

  for (const [sourceTrack, events] of absoluteTracks.entries()) {
    const active = new Map<string, Array<{ ticks: number; velocity: number; sourceOrder: number }>>();
    const clock = tempoClock(sourceTrack);
    for (const { event, ticks } of events) {
      if (event.type !== 'noteOn' && event.type !== 'noteOff') continue;
      const key = `${event.channel}:${event.noteNumber}`;
      const noteOff = event.type === 'noteOff' || event.velocity === 0;
      if (!noteOff) {
        const queue = active.get(key) ?? [];
        queue.push({ ticks, velocity: event.velocity, sourceOrder: noteOrder });
        noteOrder += 1;
        active.set(key, queue);
        continue;
      }
      const queue = active.get(key);
      const started = queue?.shift();
      if (!started) continue;
      notes.push({
        startSec: ticksToSeconds(started.ticks, ppq, clock),
        endSec: ticksToSeconds(ticks, ppq, clock),
        pitchMidi: event.noteNumber,
        velocity: Math.max(1, Math.min(127, started.velocity)),
        confidence: 1,
        sourceTrack,
        sourceChannel: event.channel,
        sourceOrder: started.sourceOrder,
        sourceStartTicks: started.ticks,
        sourceEndTicks: ticks,
      });
    }
  }

  const canonicalTempos: RawMidiTempoEvent[] = sortedTempos.map((tempo) => ({
    ticks: tempo.ticks,
    bpm: 60_000_000 / tempo.microsecondsPerBeat,
    timeSec: ticksToSeconds(tempo.ticks, ppq, tempoClock(tempo.sourceTrack)),
    sourceTrack: tempo.sourceTrack,
    sourceOrder: tempo.sourceOrder,
  }));
  const canonicalSignatures: RawMidiTimeSignatureEvent[] = signatures
    .sort((a, b) => a.ticks - b.ticks || a.sourceTrack - b.sourceTrack || a.sourceOrder - b.sourceOrder)
    .map((signature) => ({
      ticks: signature.ticks,
      timeSignature: [signature.numerator, signature.denominator],
      timeSec: ticksToSeconds(signature.ticks, ppq, tempoClock(signature.sourceTrack)),
      sourceTrack: signature.sourceTrack,
      sourceOrder: signature.sourceOrder,
    }));
  return {
    notes: notes.sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0)),
    tempos: canonicalTempos,
    timeSignatures: canonicalSignatures,
    ppq,
    durationSec: Math.max(0, ...notes.map((note) => note.endSec)),
  };
}

function ticksToSeconds(ticks: number, ppq: number, tempos: readonly AbsoluteTempo[]): number {
  let seconds = 0;
  let previousTicks = 0;
  let microsecondsPerBeat = 500_000;
  for (const tempo of tempos) {
    if (tempo.ticks > ticks) break;
    seconds += ((tempo.ticks - previousTicks) * microsecondsPerBeat) / (ppq * 1_000_000);
    previousTicks = tempo.ticks;
    microsecondsPerBeat = tempo.microsecondsPerBeat;
  }
  return seconds + ((ticks - previousTicks) * microsecondsPerBeat) / (ppq * 1_000_000);
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
        sourceChannel: note.sourceChannel,
        sourceTrack: note.sourceTrack,
        sourceOrder: note.sourceOrder,
        sourceEndSec: note.endSec,
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
