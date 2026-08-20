import type { NoteEvent } from '@contracts';
import type { RuleProposal, TeacherRule } from './types';

/**
 * Phrase shaping.
 *
 * The most recognisably pedagogical suggestion in the set: *hold the last note*.
 *
 * A phrase that ends on a note the same length as everything before it does not
 * sound finished — it sounds interrupted. Singers know to lean on a final note,
 * and beginners routinely clip it, especially when humming into a phone and
 * unsure of themselves.
 *
 * ## What stops this from becoming a mannerism
 *
 * It only fires when the ending is genuinely clipped: the last note must be
 * shorter than the phrase's own median, and there must be real silence after it
 * so lengthening cannot collide with what follows. A phrase that already ends
 * long is left alone, and a two-note phrase is not a phrase.
 */
export const phraseShapingRule: TeacherRule = {
  id: 'phrase-shaping',
  purpose: 'lengthens a clipped final note so the phrase sounds finished',

  propose(notes, analysis) {
    if (analysis.phrases.length === 0) return [];
    const proposals: RuleProposal[] = [];

    for (const phrase of analysis.phrases) {
      const length = phrase.endIndex - phrase.startIndex + 1;
      if (length < 3) continue;

      const last = notes[phrase.endIndex];
      if (last === undefined) continue;

      const lastDuration = last.endSec - last.startSec;
      const phraseMedian = medianDuration(notes, phrase.startIndex, phrase.endIndex - 1);
      if (phraseMedian <= 0) continue;
      // Already held: nothing to suggest.
      if (lastDuration >= phraseMedian * 1.15) continue;

      // Never past the next phrase, and never past the silence that defines
      // this one as a phrase in the first place.
      const next = notes[phrase.endIndex + 1];
      const ceiling =
        next !== undefined ? next.startSec - 0.02 : last.endSec + phraseMedian;
      const target = Math.min(ceiling, last.startSec + phraseMedian * 1.5);
      if (target - last.endSec < 0.04) continue;

      proposals.push({
        note: { ...last, endSec: target },
        edit: {
          noteIndex: phrase.endIndex,
          kind: 'phrase-ending-lengthened',
          from: Math.round(lastDuration * 1000),
          to: Math.round((target - last.startSec) * 1000),
          reason: 'the phrase ended abruptly; holding the last note lets it settle',
        },
      });
    }

    return proposals;
  },
};

function medianDuration(notes: readonly NoteEvent[], from: number, to: number): number {
  const durations: number[] = [];
  for (let i = from; i <= to; i += 1) {
    const note = notes[i];
    if (note) durations.push(note.endSec - note.startSec);
  }
  if (durations.length === 0) return 0;
  durations.sort((a, b) => a - b);
  const mid = durations.length >> 1;
  return durations.length % 2 === 1
    ? (durations[mid] as number)
    : ((durations[mid - 1] as number) + (durations[mid] as number)) / 2;
}
