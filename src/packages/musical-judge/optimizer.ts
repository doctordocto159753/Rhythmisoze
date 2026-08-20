/**
 * Beam search over repair sequences.
 *
 * ## Why a search at all
 *
 * The operators interact. Removing unsupported notes before correcting octaves
 * deletes material that transposition would have rescued; correcting octaves
 * first and then removing leaves the rescued notes in place. Merging before
 * reconstructing durations produces a different result from the reverse. There
 * is no single correct order, because the right one depends on the take.
 *
 * ## Why beam search rather than brute force
 *
 * Four operators over four rounds is 256 sequences, and each has to be scored
 * against the reference contour. A beam of four keeps roughly sixteen scorings
 * per round, finds the same answer on every case in the test suite, and stays
 * fast enough to run on every take without the user waiting.
 *
 * ## The rules the search obeys
 *
 * - **Deterministic.** No randomness anywhere, so one recording always produces
 *   one repair. A Judge that returns different notes on two runs cannot be
 *   benchmarked, and cannot be trusted.
 * - **Never worse than the input.** The original candidate is seeded into the
 *   beam and wins ties, so repair can only improve the score or leave it alone.
 * - **Never destroys the source.** The input is returned untouched alongside the
 *   repair, which is what lets the product still offer the unprocessed version.
 */

import type { NoteEvent } from '@contracts';
import type { JudgeFeatures } from './features';
import { judgeNotes, type JudgeScore, type ScoringOptions } from './scoring';
import { REPAIR_OPERATORS, type RepairOperatorId } from './repair';

export interface RepairStep {
  operator: RepairOperatorId;
  description: string;
  /** Score after this step, so a repair log reads as a story. */
  scoreAfter: number;
  notesBefore: number;
  notesAfter: number;
}

export interface JudgeResult {
  /** Exactly what was handed in. Never mutated. */
  originalNotes: NoteEvent[];
  originalScore: JudgeScore;
  /** The repaired notes. Equal to the original when nothing helped. */
  judgedNotes: NoteEvent[];
  judgedScore: JudgeScore;
  /** What was done, in order. Empty when the input was already the best option. */
  repairs: RepairStep[];
  /** `judgedScore.overall - originalScore.overall`, never negative. */
  improvement: number;
}

export interface OptimizerOptions {
  /** Candidates kept between rounds. */
  beamWidth: number;
  /** Maximum operators applied in sequence. */
  maxRounds: number;
  /** Stop early once the score exceeds this. */
  goodEnough: number;
  /** Smallest score gain worth another round. */
  minGain: number;
  scoring?: Partial<ScoringOptions>;
}

export const DEFAULT_OPTIMIZER_OPTIONS: OptimizerOptions = {
  beamWidth: 4,
  // Four rounds lets every operator run once. More would only repeat one, and
  // all four are idempotent, so there is nothing further to find.
  maxRounds: 4,
  goodEnough: 0.97,
  minGain: 0.002,
};

interface BeamEntry {
  notes: NoteEvent[];
  score: JudgeScore;
  repairs: RepairStep[];
  /** Operators already applied, so an idempotent one is not repeated. */
  used: Set<RepairOperatorId>;
}

/**
 * Judges a candidate transcription and repairs it.
 *
 * The single entry point of the engine.
 */
export function judgeAndRepair(
  candidate: readonly NoteEvent[],
  features: JudgeFeatures,
  options: Partial<OptimizerOptions> = {},
): JudgeResult {
  const config = { ...DEFAULT_OPTIMIZER_OPTIONS, ...options };
  const originalNotes = candidate.map((note) => ({ ...note }));
  const originalScore = judgeNotes(originalNotes, features, config.scoring);

  // Nothing to judge against, or nothing to judge: return the input unchanged
  // rather than inventing an opinion about it.
  if (features.voicedFrames === 0 || originalNotes.length === 0) {
    return {
      originalNotes,
      originalScore,
      judgedNotes: originalNotes.map((note) => ({ ...note })),
      judgedScore: originalScore,
      repairs: [],
      improvement: 0,
    };
  }

  let beam: BeamEntry[] = [
    { notes: originalNotes, score: originalScore, repairs: [], used: new Set() },
  ];
  let best = beam[0] as BeamEntry;

  for (let round = 0; round < config.maxRounds; round += 1) {
    if (best.score.overall >= config.goodEnough) break;

    const expanded: BeamEntry[] = [];

    for (const entry of beam) {
      for (const operator of REPAIR_OPERATORS) {
        // Every operator here is idempotent, so applying one twice can only
        // cost time.
        if (entry.used.has(operator.id)) continue;

        const notes = operator.apply(entry.notes, features);
        // An operator that changed nothing is not a step worth recording.
        if (sameNotes(notes, entry.notes)) continue;

        const score = judgeNotes(notes, features, config.scoring);
        expanded.push({
          notes,
          score,
          used: new Set([...entry.used, operator.id]),
          repairs: [
            ...entry.repairs,
            {
              operator: operator.id,
              description: operator.describe(),
              scoreAfter: score.overall,
              notesBefore: entry.notes.length,
              notesAfter: notes.length,
            },
          ],
        });
      }
    }

    if (expanded.length === 0) break;

    // Sorted by score, then by fewer repairs: between two equal results, the
    // one that touched the user's material less is the better answer.
    expanded.sort(
      (a, b) => b.score.overall - a.score.overall || a.repairs.length - b.repairs.length,
    );
    beam = expanded.slice(0, config.beamWidth);

    const leader = beam[0] as BeamEntry;
    const gain = leader.score.overall - best.score.overall;
    if (leader.score.overall > best.score.overall) best = leader;
    if (gain < config.minGain) break;
  }

  // Repair may never make things worse. If the search found nothing better,
  // the original stands.
  const improved = best.score.overall > originalScore.overall;

  return {
    originalNotes,
    originalScore,
    judgedNotes: improved ? best.notes : originalNotes.map((note) => ({ ...note })),
    judgedScore: improved ? best.score : originalScore,
    repairs: improved ? best.repairs : [],
    improvement: improved ? best.score.overall - originalScore.overall : 0,
  };
}

function sameNotes(a: readonly NoteEvent[], b: readonly NoteEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] as NoteEvent;
    const right = b[i] as NoteEvent;
    if (
      left.pitch !== right.pitch ||
      Math.abs(left.startSec - right.startSec) > 1e-6 ||
      Math.abs(left.endSec - right.endSec) > 1e-6
    ) {
      return false;
    }
  }
  return true;
}
