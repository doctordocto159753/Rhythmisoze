/**
 * Musical-preservation metrics.
 *
 * Accuracy against synthesised ground truth says whether the transcription is
 * right. Preservation asks the product question: **what did our own later
 * stages do to what the user gave us.** The priority order — preserve intent,
 * never destructively interpret, only then improve — becomes measurable here.
 *
 * The input to these metrics is the transformation history the pipeline itself
 * records (see `@/packages/note-history`), plus a register comparison between
 * stage outputs. If a stage moves material an octave, that fact appears in
 * these numbers regardless of what any repair log claims.
 */

import type { NoteEvent, NoteTransformation } from '@contracts';

export interface PreservationMetrics {
  /** Median pitch of the candidate note set, or 0 when empty. */
  candidateMedianPitch: number;
  /** Median pitch of the final note set, or 0 when empty. */
  finalMedianPitch: number;
  /** Final median − candidate median, semitones. Non-zero means a register move. */
  registerShift: number;
  /** Note count at each recorded stage, in pipeline order. */
  noteCountByStage: Record<string, number>;
  /** Mechanical changes per stage. */
  changesByStage: Record<string, number>;
  /**
   * Pitch rewrites per stage that crossed an octave boundary. Under the
   * single-octave-authority rule this must stay zero for the judge stage on
   * voice-route material; a non-zero value here is a regression alarm even if
   * every accuracy number improved.
   */
  octaveChangesByStage: Record<string, number>;
}

/**
 * Summarises one or more stage diffs of the same candidate stream.
 *
 * `stages` is ordered; counts accumulate per stage label so a report can show
 * exactly where material was touched.
 */
export function computePreservation(
  stages: ReadonlyArray<{ stage: string; before: readonly NoteEvent[]; after: readonly NoteEvent[] }>,
  transformations: readonly NoteTransformation[],
): PreservationMetrics {
  const first = stages[0];
  const last = stages[stages.length - 1];
  const noteCountByStage: Record<string, number> = {};
  const changesByStage: Record<string, number> = {};
  const octaveChangesByStage: Record<string, number> = {};

  for (const { stage, after } of stages) {
    noteCountByStage[stage] = after.length;
    changesByStage[stage] = 0;
    octaveChangesByStage[stage] = 0;
  }
  for (const record of transformations) {
    changesByStage[record.stage] = (changesByStage[record.stage] ?? 0) + 1;
    if (
      record.kind === 'pitch-shifted' &&
      record.fromPitch !== undefined &&
      record.toPitch !== undefined &&
      Math.abs(Math.abs(record.toPitch - record.fromPitch) - 12) < 2
    ) {
      octaveChangesByStage[record.stage] = (octaveChangesByStage[record.stage] ?? 0) + 1;
    }
  }

  return {
    candidateMedianPitch: medianPitch(first?.before ?? []),
    finalMedianPitch: medianPitch(last?.after ?? []),
    registerShift:
      (last ? medianPitch(last.after) : 0) - (first ? medianPitch(first.before) : 0),
    noteCountByStage,
    changesByStage,
    octaveChangesByStage,
  };
}

function medianPitch(notes: readonly NoteEvent[]): number {
  if (notes.length === 0) return 0;
  const sorted = notes.map((note) => note.pitch).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
