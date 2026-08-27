/** Immutable Raw boundary shared by MIDI import and GAME audio transcription. */

import type {
  DrumEvent,
  LocalSourceAsset,
  NoteEvent,
  RawNoteEvent,
  RawTranscription,
} from '@contracts';

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Convert authoritative Raw notes to the existing downstream event vocabulary. */
export function rawNotesForProcessing(raw: RawTranscription): NoteEvent[] {
  return raw.notes.map((note) => ({
    startSec: finite(note.startSec),
    endSec: Math.max(finite(note.startSec) + 0.01, finite(note.endSec)),
    pitch: finite(note.pitchMidi),
    velocity: Math.max(1, Math.min(127, Math.round(note.velocity ?? 96))),
    ...(note.confidence === undefined ? {} : { confidence: note.confidence }),
    ...(note.sourceTrack === undefined ? {} : { sourceTrack: note.sourceTrack }),
    ...(note.sourceChannel === undefined ? {} : { sourceChannel: note.sourceChannel }),
    ...(note.sourceOrder === undefined ? {} : { sourceOrder: note.sourceOrder }),
    ...(note.sourceStartTicks === undefined ? {} : { sourceStartTicks: note.sourceStartTicks }),
    ...(note.sourceEndTicks === undefined ? {} : { sourceEndTicks: note.sourceEndTicks }),
  }));
}

/**
 * Own and freeze a Raw value at the reducer boundary.
 *
 * `Object.freeze` alone would freeze somebody else's arrays. Copying first
 * makes ownership explicit; recursively freezing the small value graph turns
 * accidental Judge/Musician mutation into an immediate test failure.
 */
export function freezeRawTranscription(input: RawTranscription): RawTranscription {
  const notes = input.notes.map((note): Readonly<RawNoteEvent> => Object.freeze({ ...note }));
  const drums = input.drums.map((drum): Readonly<DrumEvent> => Object.freeze({ ...drum }));
  const midi = input.midi
    ? Object.freeze({
        ...input.midi,
        tempos: Object.freeze(input.midi.tempos.map((tempo) => Object.freeze({ ...tempo }))),
        timeSignatures: Object.freeze(
          input.midi.timeSignatures.map((signature) =>
            Object.freeze({
              ...signature,
              timeSignature: Object.freeze([...signature.timeSignature]) as unknown as readonly [number, number],
            }),
          ),
        ),
      })
    : undefined;
  return Object.freeze({
    ...input,
    notes: Object.freeze(notes),
    drums: Object.freeze(drums),
    provenance: Object.freeze({ ...input.provenance }),
    ...(midi ? { midi } : {}),
  });
}

/** The only Raw MIDI artifact writer: return the original Blob, never a reconstruction. */
export function exactRawMidiArtifact(
  source: LocalSourceAsset | null,
  raw: RawTranscription | null,
): Blob | null {
  return source?.kind === 'midi-upload' && raw?.sourceKind === 'midi' ? source.blob : null;
}
