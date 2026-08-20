import type { NoteEvent } from '@contracts';
import type { MelodyAnalysis } from '../analysis';
import type { RuleProposal, TeacherRule } from './types';

/**
 * Rhythm refinement.
 *
 * Removes the jitter a human leaves without removing the human.
 *
 * ## The distinction the whole rule turns on
 *
 * A note 20 ms off the beat is a note that was *meant* to be on the beat. A
 * note 200 ms off the beat is somewhere else on purpose — it is a syncopation,
 * a hesitation, or a phrase that breathes. Dragging the second one onto the
 * grid does not tidy the performance, it deletes an intention.
 *
 * So correction only applies inside a window around the grid: close notes are
 * pulled in, distant ones are left exactly where the player put them. This is
 * the difference between a teacher saying "tighten that up" and a teacher
 * rewriting the rhythm.
 *
 * ## The grid is the performer's own
 *
 * From `rhythm-extraction`, recovered from the recording. The tapped BPM is
 * never consulted here — the brief for this layer is explicit that the Teacher
 * must not force it, and a grid the performer never played to is not a
 * correction, it is a different piece.
 *
 * When no pulse was confidently heard, this rule proposes nothing at all.
 */
export const rhythmRefinementRule: TeacherRule = {
  id: 'rhythm-refinement',
  purpose: 'pulls notes that nearly landed on the beat onto it, and leaves the rest alone',

  propose(notes, analysis) {
    const step = analysis.gridStepSec;
    const rhythm = analysis.rhythm;
    if (step === null || step <= 0 || rhythm === null) return [];

    const phase = rhythm.tempo.phaseSec;
    // A third of a grid step: comfortably wider than human jitter, narrower
    // than any deliberate displacement.
    const window = step * 0.34;
    const proposals: RuleProposal[] = [];

    notes.forEach((note, index) => {
      const offsetFromPhase = note.startSec - phase;
      const nearest = Math.round(offsetFromPhase / step) * step + phase;
      const drift = note.startSec - nearest;

      if (Math.abs(drift) < 0.004 || Math.abs(drift) > window) return;
      if (nearest < 0) return;

      // The note moves as a whole: shifting the start alone would silently
      // change its length, which is a different suggestion.
      const duration = note.endSec - note.startSec;
      proposals.push({
        note: { ...note, startSec: nearest, endSec: nearest + duration },
        edit: {
          noteIndex: index,
          kind: 'timing-to-grid',
          from: Math.round(note.startSec * 1000),
          to: Math.round(nearest * 1000),
          reason: `note ${index + 1} was ${Math.abs(Math.round(drift * 1000))} ms off the beat you were keeping`,
        },
      });
    });

    return proposals;
  },
};

/**
 * Duration regularisation.
 *
 * Separate from the timing rule because it answers a different question: not
 * *when* did the note start, but *how long was it meant to be*.
 *
 * A melody whose notes are nearly all one length, with one that is 1.4x its
 * neighbours, has a note that was held slightly too long — not a note of a
 * different value. The rule only nudges outliers toward the melody's own median
 * duration, and only when they are close enough to it that no rhythmic value
 * changes.
 */
export const durationRegularityRule: TeacherRule = {
  id: 'duration-regularity',
  purpose: 'evens out a note held slightly longer or shorter than its neighbours',

  propose(notes, analysis) {
    const target = analysis.medianDurationSec;
    if (target <= 0 || notes.length < 4) return [];

    const durations = notes.map((note) => note.endSec - note.startSec);
    const spread = medianAbsoluteDeviation(durations, target);
    // A melody with genuinely varied note values has nothing to regularise, and
    // forcing one on it would flatten the rhythm into a drum machine.
    if (spread > target * 0.5) return [];

    const proposals: RuleProposal[] = [];
    notes.forEach((note, index) => {
      const duration = note.endSec - note.startSec;
      const ratio = duration / target;
      // Only genuine outliers, and only ones near enough that the note keeps
      // its rhythmic value.
      if (ratio > 0.7 && ratio < 1.35) return;
      if (ratio <= 0.4 || ratio >= 2.2) return;

      const next = notes[index + 1];
      let end = note.startSec + target;
      if (next !== undefined) end = Math.min(end, next.startSec);
      if (Math.abs(end - note.endSec) < 0.01) return;

      proposals.push({
        note: { ...note, endSec: end },
        edit: {
          noteIndex: index,
          kind: 'duration-regularised',
          from: Math.round(duration * 1000),
          to: Math.round((end - note.startSec) * 1000),
          reason: `note ${index + 1} was ${ratio > 1 ? 'longer' : 'shorter'} than the notes around it`,
        },
      });
    });

    return proposals;
  },
};

function medianAbsoluteDeviation(values: readonly number[], centre: number): number {
  const deviations = values.map((value) => Math.abs(value - centre)).sort((a, b) => a - b);
  const mid = deviations.length >> 1;
  if (deviations.length === 0) return 0;
  return deviations.length % 2 === 1
    ? (deviations[mid] as number)
    : ((deviations[mid - 1] as number) + (deviations[mid] as number)) / 2;
}
