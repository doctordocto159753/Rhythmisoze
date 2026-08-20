/**
 * The lesson.
 *
 * Runs the rules in their fixed pedagogical order, applies each suggestion only
 * if it survives the constraints, and returns the revision together with an
 * account of every change.
 *
 * ## The three gates every suggestion passes
 *
 * 1. **Budget.** At most a third of the notes may be touched. A teacher who
 *    rewrites half a phrase has stopped teaching.
 * 2. **Coherence.** The suggestion must actually improve the melody. A rule
 *    firing is not evidence that it helped.
 * 3. **Identity.** The result must still be recognisably the same melody, and
 *    identity is re-checked after every accepted change rather than once at the
 *    end — a series of individually harmless edits can add up to a different
 *    tune.
 *
 * ## Determinism
 *
 * No randomness, fixed rule order, and suggestions applied in index order. The
 * same Judge melody always produces the same lesson, which is what makes this
 * testable at all given it has no ground truth to check against.
 */

import type { NoteEvent } from '@contracts';
import { analyseMelody, type MelodyAnalysis } from '../analysis';
import { TEACHER_RULES, type RuleProposal } from '../rules';
import { scoreCoherence, scoreIdentity } from '../scoring';
import {
  IDENTITY_FLOOR,
  MAX_EDITED_FRACTION,
  type TeacherEdit,
  type TeacherResult,
} from '../types';

export interface TeachOptions {
  /** Ceiling on the fraction of notes that may be edited. */
  maxEditedFraction?: number;
  /** Identity score below which a revision is rejected. */
  identityFloor?: number;
  /** Smallest coherence gain that justifies touching a note. */
  minCoherenceGain?: number;
}

/**
 * The smallest improvement worth making a change for.
 *
 * Deliberately non-zero. A suggestion that improves the proxy by a rounding
 * error has not improved the music, and every unnecessary edit spends identity
 * budget that a real correction might need.
 */
const DEFAULT_MIN_GAIN = 0.004;

/**
 * Turns the Judge's faithful reading into what a teacher would suggest.
 *
 * `notes` must be the Judge's output, not the raw candidate: tidying a melody
 * that still contains a harmonic artifact or an octave slip produces a tidy
 * version of the wrong notes.
 */
export function teach(
  notes: readonly NoteEvent[],
  durationSec: number,
  options: TeachOptions = {},
): TeacherResult {
  const maxEditedFraction = options.maxEditedFraction ?? MAX_EDITED_FRACTION;
  const identityFloor = options.identityFloor ?? IDENTITY_FLOOR;
  const minGain = options.minCoherenceGain ?? DEFAULT_MIN_GAIN;

  const inputNotes = [...notes]
    .sort((a, b) => a.startSec - b.startSec)
    .map((note) => ({ ...note }));

  const analysis = analyseMelody(inputNotes, durationSec);
  const coherenceBefore = scoreCoherence(inputNotes, analysis);

  // Too little to teach from. Three notes have no phrase, no motif and no
  // reliable key, and a suggestion made from them would be invention.
  if (inputNotes.length < 4) {
    return unchangedResult(inputNotes, analysis, coherenceBefore);
  }

  let current = inputNotes.map((note) => ({ ...note }));
  const edits: TeacherEdit[] = [];
  const touched = new Set<number>();
  const budget = Math.max(1, Math.floor(inputNotes.length * maxEditedFraction));

  for (const rule of TEACHER_RULES) {
    if (touched.size >= budget) break;

    // Proposals are computed against the melody as it stands, so a later rule
    // sees the earlier rules' work rather than the original.
    const currentAnalysis = analyseMelody(current, durationSec);
    const proposals = rule
      .propose(current, currentAnalysis)
      .sort((a, b) => a.edit.noteIndex - b.edit.noteIndex);

    for (const proposal of proposals) {
      if (touched.size >= budget) break;
      const accepted = tryApply(current, proposal, inputNotes, durationSec, {
        identityFloor,
        minGain,
      });
      if (accepted === null) continue;

      current = accepted;
      touched.add(proposal.edit.noteIndex);
      edits.push(proposal.edit);
    }
  }

  const finalAnalysis = analyseMelody(current, durationSec);
  const coherenceAfter = scoreCoherence(current, finalAnalysis);
  const identity = scoreIdentity(inputNotes, current);

  // A last whole-result check. Individually acceptable edits can still combine
  // into something the melody's owner would not recognise.
  if (edits.length === 0 || identity.overall < identityFloor) {
    return unchangedResult(inputNotes, analysis, coherenceBefore);
  }

  return {
    inputNotes,
    notes: current,
    edits,
    coherenceBefore,
    coherenceAfter,
    identity,
    key: analysis.key
      ? {
          root: analysis.key.root,
          mode: analysis.key.mode,
          confidence: analysis.key.confidence,
        }
      : null,
    unchanged: false,
  };
}

/**
 * Applies one suggestion if it passes coherence and identity.
 * Returns the new melody, or `null` when the suggestion is refused.
 */
function tryApply(
  current: readonly NoteEvent[],
  proposal: RuleProposal,
  original: readonly NoteEvent[],
  durationSec: number,
  limits: { identityFloor: number; minGain: number },
): NoteEvent[] | null {
  const index = proposal.edit.noteIndex;
  if (index < 0 || index >= current.length) return null;

  const candidate = current.map((note, i) => (i === index ? { ...proposal.note } : note));

  // A change that reorders the melody, or gives a note no length, is not a
  // suggestion a teacher would make.
  if (!isWellFormed(candidate)) return null;

  const before = scoreCoherence(current, analyseMelody(current, durationSec));
  const after = scoreCoherence(candidate, analyseMelody(candidate, durationSec));
  if (after.overall - before.overall < limits.minGain) return null;

  if (scoreIdentity(original, candidate).overall < limits.identityFloor) return null;

  return candidate;
}

/** Notes in order, none inverted, none of zero length. */
function isWellFormed(notes: readonly NoteEvent[]): boolean {
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i] as NoteEvent;
    if (!(note.endSec > note.startSec)) return false;
    const next = notes[i + 1];
    if (next !== undefined && next.startSec < note.startSec - 1e-9) return false;
  }
  return true;
}

function unchangedResult(
  inputNotes: NoteEvent[],
  analysis: MelodyAnalysis,
  coherence: ReturnType<typeof scoreCoherence>,
): TeacherResult {
  return {
    inputNotes,
    notes: inputNotes.map((note) => ({ ...note })),
    edits: [],
    coherenceBefore: coherence,
    coherenceAfter: coherence,
    identity: scoreIdentity(inputNotes, inputNotes),
    key: analysis.key
      ? {
          root: analysis.key.root,
          mode: analysis.key.mode,
          confidence: analysis.key.confidence,
        }
      : null,
    unchanged: true,
  };
}
