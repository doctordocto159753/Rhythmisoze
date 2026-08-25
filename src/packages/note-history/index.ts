/**
 * Per-note transformation records for observability.
 *
 * The pipeline's later stages — Judge repair, phrase interpretation, Teacher
 * suggestions — each transform the candidate note set. When a take comes out
 * wrong, the first question is *which stage changed what*, and today that
 * answer lives only in scattered repair logs. This module makes the changes
 * themselves first-class data: a dumb, bounded diff of two note lists with a
 * stage label.
 *
 * Deliberately not an interpretation. Matching is greedy nearest-onset, kinds
 * are mechanical (`removed` / `added` / `pitch-shifted` / `moved`), and no
 * musical reason is inferred here — consumers that know why something changed
 * attach their own evidence alongside these records.
 */

import type { NoteEvent, NoteTransformation } from '@contracts';

/** Two notes closer than this in onset are the same note, changed or moved. */
const MATCH_WINDOW_SEC = 0.03;

/** A boundary shift smaller than this is float noise, not a move. */
const MOVE_EPSILON_SEC = 0.02;

/**
 * Diffs one stage's output against its input.
 *
 * `stage` labels every record produced here ("judge", "teacher", ...). The
 * result is ordered by time so a log reads left-to-right like the music.
 */
export function noteTransformations(
  stage: string,
  before: readonly NoteEvent[],
  after: readonly NoteEvent[],
): NoteTransformation[] {
  const remaining = new Set(after.map((_, index) => index));
  const out: NoteTransformation[] = [];

  for (const note of before) {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    remaining.forEach((index) => {
      const candidate = after[index] as NoteEvent;
      const delta = Math.abs(candidate.startSec - note.startSec);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    });

    const matched =
      bestIndex >= 0 && bestDelta <= MATCH_WINDOW_SEC ? (after[bestIndex] as NoteEvent) : null;
    if (matched === null) {
      out.push({
        stage,
        kind: 'removed',
        startSec: round(note.startSec),
        endSec: round(note.endSec),
        fromPitch: note.pitch,
      });
      continue;
    }
    remaining.delete(bestIndex);

    if (matched.pitch !== note.pitch) {
      out.push({
        stage,
        kind: 'pitch-shifted',
        startSec: round(matched.startSec),
        endSec: round(matched.endSec),
        fromPitch: note.pitch,
        toPitch: matched.pitch,
      });
    } else if (
      Math.abs(matched.startSec - note.startSec) > MOVE_EPSILON_SEC ||
      Math.abs(matched.endSec - note.endSec) > MOVE_EPSILON_SEC
    ) {
      out.push({
        stage,
        kind: 'moved',
        startSec: round(matched.startSec),
        endSec: round(matched.endSec),
        fromPitch: note.pitch,
        toPitch: matched.pitch,
      });
    }
  }

  for (const index of remaining) {
    const note = after[index] as NoteEvent;
    out.push({
      stage,
      kind: 'added',
      startSec: round(note.startSec),
      endSec: round(note.endSec),
      toPitch: note.pitch,
    });
  }

  return out.sort((a, b) => a.startSec - b.startSec || (a.fromPitch ?? 0) - (b.fromPitch ?? 0));
}

/**
 * Collects several stage diffs into one bounded history.
 *
 * The cap keeps a pathological take from writing thousands of records into
 * saved diagnostics; when the cap bites, the earliest stages win because they
 * answer the question that matters first — what did the transcription look
 * like before anyone touched it.
 */
export function buildTransformationHistory(
  stages: ReadonlyArray<{ stage: string; before: readonly NoteEvent[]; after: readonly NoteEvent[] }>,
  limit = 200,
): NoteTransformation[] {
  const all = stages.flatMap(({ stage, before, after }) => noteTransformations(stage, before, after));
  return all.length > limit ? all.slice(0, limit) : all;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
