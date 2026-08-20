import type { NoteEvent } from '@contracts';
import type { RuleProposal, TeacherRule } from './types';

/**
 * Motif consistency.
 *
 * *You played that figure twice — make it the same both times.*
 *
 * When a melody repeats an interval pattern, the repetition is the point: it is
 * what makes a tune memorable. A performer who rushes the second occurrence has
 * not written a variation, they have played one idea unevenly, and evening it
 * out is among the most useful things a teacher can point at.
 *
 * ## Only rhythm, never pitch
 *
 * The rule aligns *durations* and never touches a pitch. The occurrences were
 * identified *by* their intervals, so their pitches already agree by
 * construction; changing pitch here could only move a note away from what was
 * actually sung.
 *
 * ## Only near-misses
 *
 * Occurrences whose rhythms already differ substantially are a deliberate
 * variation, and forcing those into agreement would be composing.
 */
export const motifConsistencyRule: TeacherRule = {
  id: 'motif-consistency',
  purpose: 'evens out the rhythm between repeats of the same figure',

  propose(notes, analysis) {
    if (analysis.motifs.length === 0) return [];
    const proposals: RuleProposal[] = [];
    // One suggestion per note, so two overlapping motifs cannot both claim it.
    const claimed = new Set<number>();

    for (const motif of analysis.motifs) {
      if (motif.occurrences.length < 2) continue;
      const span = motif.intervals.length + 1;

      // The first occurrence is the reference: it is what the performer meant
      // before any rushing set in.
      const referenceStart = motif.occurrences[0] as number;
      const reference = durationsAt(notes, referenceStart, span);
      if (reference.length !== span) continue;

      for (const start of motif.occurrences.slice(1)) {
        const current = durationsAt(notes, start, span);
        if (current.length !== span) continue;

        for (let offset = 0; offset < span; offset += 1) {
          const index = start + offset;
          if (claimed.has(index)) continue;

          const note = notes[index];
          const want = reference[offset] as number;
          const have = current[offset] as number;
          if (note === undefined || want <= 0 || have <= 0) continue;

          const ratio = have / want;
          // Already matching, or deliberately different: both left alone.
          if (ratio > 0.85 && ratio < 1.18) continue;
          if (ratio < 0.55 || ratio > 1.8) continue;

          const next = notes[index + 1];
          const end = Math.min(
            note.startSec + want,
            next !== undefined ? next.startSec : Number.POSITIVE_INFINITY,
          );
          if (Math.abs(end - note.endSec) < 0.02) continue;

          claimed.add(index);
          proposals.push({
            note: { ...note, endSec: end },
            edit: {
              noteIndex: index,
              kind: 'motif-aligned',
              from: Math.round(have * 1000),
              to: Math.round((end - note.startSec) * 1000),
              reason: 'this figure appears earlier in the melody; the repeat now matches it',
            },
          });
        }
      }
    }

    return proposals;
  },
};

function durationsAt(notes: readonly NoteEvent[], start: number, span: number): number[] {
  const out: number[] = [];
  for (let i = start; i < start + span; i += 1) {
    const note = notes[i];
    if (note === undefined) return [];
    out.push(note.endSec - note.startSec);
  }
  return out;
}
