import { Note } from 'tonal';
import type { NoteEvent } from '@contracts';
import type { MelodyAnalysis } from '../analysis';
import { MAX_PITCH_SHIFT_SEMITONES } from '../types';
import type { RuleProposal, TeacherRule } from './types';

/**
 * Key-aware pitch correction.
 *
 * The suggestion a teacher makes most often: *that note is outside the key —
 * did you mean the one next to it?*
 *
 * ## When it stays silent, and why that matters more than when it speaks
 *
 * A chromatic note is not automatically a mistake. It is a mistake when the
 * rest of the melody is firmly in a key and this one note is not. So the rule
 * requires all of:
 *
 *  - a **trusted key** — confident detection *and* a melody that mostly agrees
 *    with it, because correcting toward a key the singer never used is worse
 *    than leaving the note alone;
 *  - a **short note** — a long out-of-key note is almost always deliberate,
 *    and is what gives blues and modal melodies their character;
 *  - a **small move** — at most a whole tone. Anything further is a different
 *    note, not a correction.
 *
 * The example from the brief is exactly this case: `C D F# E` in C major, where
 * F♯ is brief and everything around it is diatonic, becomes `C D F E`.
 */
export const keyCoherenceRule: TeacherRule = {
  id: 'key-coherence',
  purpose: 'moves a brief out-of-key note to the nearest note of the key',

  propose(notes, analysis) {
    const key = analysis.key;
    if (key === null || !key.trusted) return [];

    const proposals: RuleProposal[] = [];
    // "Brief" relative to this melody, not to an absolute duration.
    const shortEnough = Math.max(0.35, analysis.medianDurationSec * 1.15);

    notes.forEach((note, index) => {
      const pitchClass = ((note.pitch % 12) + 12) % 12;
      if (key.scalePitchClasses.includes(pitchClass)) return;
      if (note.endSec - note.startSec > shortEnough) return;

      const target = nearestScalePitch(note.pitch, key.scalePitchClasses);
      if (target === null) return;

      const shift = target - note.pitch;
      if (Math.abs(shift) > MAX_PITCH_SHIFT_SEMITONES) return;

      proposals.push({
        note: { ...note, pitch: target },
        edit: {
          noteIndex: index,
          kind: 'pitch-to-scale',
          from: note.pitch,
          to: target,
          reason: `${nameOf(note.pitch)} sits outside ${key.root} ${key.mode}; ${nameOf(target)} is the nearest note of the key`,
        },
      });
    });

    return proposals;
  },
};

/**
 * The closest pitch in the key.
 *
 * Ties break downward. A semitone is ambiguous by definition, and resolving
 * down is the commoner voice-leading — a raised note more often wants to fall
 * back than to rise past its neighbour.
 */
export function nearestScalePitch(pitch: number, scalePitchClasses: readonly number[]): number | null {
  if (scalePitchClasses.length === 0) return null;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let offset = -MAX_PITCH_SHIFT_SEMITONES; offset <= MAX_PITCH_SHIFT_SEMITONES; offset += 1) {
    if (offset === 0) continue;
    const candidate = pitch + offset;
    if (candidate < 0 || candidate > 127) continue;
    if (!scalePitchClasses.includes(((candidate % 12) + 12) % 12)) continue;

    const distance = Math.abs(offset);
    if (distance < bestDistance || (distance === bestDistance && offset < 0)) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function nameOf(pitch: number): string {
  return Note.fromMidi(pitch) || String(pitch);
}

/** Exported for the pipeline's coherence check. */
export function isInKey(note: NoteEvent, scalePitchClasses: readonly number[]): boolean {
  return scalePitchClasses.includes(((note.pitch % 12) + 12) % 12);
}
