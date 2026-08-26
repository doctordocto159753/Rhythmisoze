/**
 * Teacher notes into the wire format the Musician service accepts.
 *
 * ## Why this exists
 *
 * The service's contract holds every note sequence to one rule: an ordered,
 * strictly non-overlapping monophonic line (tolerance 0.1 ms — see
 * `musician_shared.contract.check_monophonic`). The app's internal note sets do
 * not have to satisfy that rule, and sometimes legitimately do not: the
 * Teacher's rhythm-refinement passes adjust onsets and durations in separate
 * steps, which can leave a note starting eight milliseconds before its
 * neighbour ends. Inaudible, harmless to everything inside this app — and a
 * hard 422 from the service, which refuses rather than repairs by design.
 *
 * The failure this caused was the worst kind: the panel offered generation, the
 * browser posted, the service refused, and the user saw "could not finish" for
 * material that was perfectly usable. So the boundary serializes into the
 * contract instead of hoping every upstream producer already satisfies it.
 *
 * ## What trimming is allowed to touch
 *
 * Only a note's tail, only down to where the next note begins, and only when
 * the trimmed note remains valid. Pitches, onsets, order, array length and every
 * clean note pass through untouched. Preserving order and length is part of the
 * contract too: phrase spans address this exact array by index. Out-of-order
 * notes or true polyphony stay unmodified so the service can refuse them rather
 * than this boundary silently changing the musical structure.
 */

import type { NoteEvent } from '@contracts';

/**
 * Overlap tolerance, mirroring `OVERLAP_TOLERANCE_SEC` in the service contract:
 * float timings out of an audio pipeline are not exact, so sub-0.1-ms crossings
 * are rounding artefacts, not polyphony.
 */
const OVERLAP_TOLERANCE_SEC = 1e-4;

/** Below this a trimmed note is not worth sending; mirrors MIN_NOTE_DURATION_SEC. */
const MIN_NOTE_DURATION_SEC = 1e-3;

/** The exact JSON shape `POST /v1/jobs` expects for `teacher.notes`. */
export interface WireNote {
  pitch: number;
  startSec: number;
  endSec: number;
  velocity: number;
}

export function serializeTeacherNotes(notes: readonly NoteEvent[]): WireNote[] {
  const out: WireNote[] = [];

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index] as NoteEvent;
    const next = notes[index + 1];
    // The existing clamps, kept verbatim: a pitch of 128 or a velocity of 0 is
    // refused by the contract just as an overlap is.
    const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
    const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)));
    let endSec = note.endSec;
    if (
      next !== undefined &&
      next.startSec < endSec - OVERLAP_TOLERANCE_SEC &&
      next.startSec - note.startSec >= MIN_NOTE_DURATION_SEC
    ) {
      endSec = next.startSec;
    }
    out.push({ pitch, startSec: note.startSec, endSec, velocity });
  }
  return out;
}
