/**
 * Scoring an *external* transcription engine against the same ground truth.
 *
 * The evaluation runner grades the engines that live inside this repository by
 * calling them. An engine that runs somewhere else — a Python model, a service,
 * a research checkout — cannot be called from a Node test, and pulling one into
 * the dependency tree in order to measure it would be the wrong order of
 * operations: the decision to adopt it is what the measurement is for.
 *
 * So the boundary is a file. An external engine writes note lists; this module
 * reads them and puts them through the *same* metrics as everything else, so
 * the numbers are comparable rather than merely coexisting.
 *
 * The interchange format is the one GAME already emits — `onset,offset,pitch`
 * in seconds — because it is the least interesting part of the problem and
 * inventing a new one would only cost an adapter.
 */

import type { NoteEvent } from '@contracts';
import {
  computeNoteMetrics,
  computePitchMetrics,
  type NoteMetrics,
  type PitchMetrics,
  type PitchObservation,
  type ReferenceNote,
} from '../metrics/pitch';

export interface ExternalNote {
  startSec: number;
  endSec: number;
  pitch: number;
}

const PITCH_CLASS_OFFSET: Readonly<Record<string, number>> = Object.freeze({
  C: 0, 'C#': 1, Cb: 11, D: 2, 'D#': 3, Db: 1, E: 4, 'E#': 5, Eb: 3,
  F: 5, 'F#': 6, Fb: 4, G: 7, 'G#': 8, Gb: 6, A: 9, 'A#': 10, Ab: 8,
  B: 11, 'B#': 0, Bb: 10,
});

const SPN = /^([A-Ga-g])([#b]?)(-?\d+)([+-]\d+(?:\.\d+)?)?$/;

/**
 * A pitch column, in either notation an engine might write it.
 *
 * A bare number is a MIDI note. GAME writes scientific pitch notation with a
 * signed cent offset instead — `A3+3`, `C#4-45` — which carries strictly more
 * information than a rounded MIDI number, and discarding the cents before the
 * comparison would grade it against a claim it never made. Both forms resolve
 * to fractional MIDI, which is what the metrics take.
 */
export function parsePitch(raw: string): number | null {
  if (raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;

  const match = SPN.exec(raw);
  if (match === null) return null;
  const key = `${(match[1] as string).toUpperCase()}${match[2] ?? ''}`;
  const pitchClass = PITCH_CLASS_OFFSET[key];
  if (pitchClass === undefined) return null;
  const octave = Number(match[3]);
  const cents = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isFinite(octave) || !Number.isFinite(cents)) return null;
  // Scientific pitch notation puts C4 at MIDI 60, hence the octave offset.
  return (octave + 1) * 12 + pitchClass + cents / 100;
}

/** Parses `onset,offset,pitch` CSV text, header optional. */
export function parseNoteCsv(text: string): ExternalNote[] {
  const notes: ExternalNote[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const startSec = Number(parts[0]);
    const endSec = Number(parts[1]);
    const pitch = parsePitch((parts[2] as string).trim());
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || pitch === null) continue;
    if (endSec <= startSec) continue;
    notes.push({ startSec, endSec, pitch });
  }
  return notes.sort((a, b) => a.startSec - b.startSec);
}

/**
 * The pitch a note list implies at each reference frame time.
 *
 * A note-level engine reports no frames, so frame metrics have to be derived
 * from what it did report. Sampling is the honest derivation: inside a note the
 * engine is claiming that pitch, and between notes it is claiming silence.
 * Nothing is interpolated across a gap, which keeps the unvoiced frames a real
 * measurement rather than a fabricated glide.
 *
 * This makes RPA/RCA/octave-error directly comparable with a frame-level
 * tracker's, with one honest caveat: a note-based engine cannot score above its
 * own segmentation. A held note tracked perfectly and a held note written as
 * one flat note look the same; a glissando written as one flat note does not.
 * That asymmetry is real, and it is why both metric families are reported side
 * by side rather than averaged into one.
 */
export function framesFromNotes(
  notes: readonly ExternalNote[],
  at: readonly PitchObservation[],
): PitchObservation[] {
  let cursor = 0;
  return at.map((reference) => {
    while (cursor < notes.length && (notes[cursor] as ExternalNote).endSec <= reference.timeSec) {
      cursor += 1;
    }
    const note = notes[cursor];
    const sounding = note !== undefined && reference.timeSec >= note.startSec;
    return { timeSec: reference.timeSec, midi: sounding ? note.pitch : null };
  });
}

export interface ExternalEngineReport {
  caseId: string;
  engine: string;
  pitch: PitchMetrics;
  notes: NoteMetrics;
}

export function scoreExternalNotes(
  caseId: string,
  engine: string,
  notes: readonly ExternalNote[],
  referenceFrames: readonly PitchObservation[],
  referenceNotes: readonly ReferenceNote[],
): ExternalEngineReport {
  return {
    caseId,
    engine,
    pitch: computePitchMetrics(referenceFrames, framesFromNotes(notes, referenceFrames)),
    notes: computeNoteMetrics(referenceNotes, notes),
  };
}

/** In-repo engines produce `NoteEvent`s; the comparison only needs three fields. */
export function asExternalNotes(notes: readonly NoteEvent[]): ExternalNote[] {
  return notes.map((note) => ({ startSec: note.startSec, endSec: note.endSec, pitch: note.pitch }));
}
