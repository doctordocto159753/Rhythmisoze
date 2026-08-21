/**
 * Performance versions.
 *
 * ## Three, and why exactly three
 *
 * ```
 * Unprocessed   the transcription as it came out, nothing applied
 * Judge         the most faithful reading of what the human actually did
 * Teacher       the Judge's reading, made musically best-practice
 * ```
 *
 * The order is a pipeline, not a menu of independent effects. The Teacher works
 * **on the Judge's output**, never on the raw candidate, because tidying a
 * transcription that still contains a harmonic artifact or an octave slip just
 * produces a tidy version of the wrong notes.
 *
 * ## Why the split is worth keeping strict
 *
 * The Judge is measurable. Its question — *did we understand the human?* — has a
 * right answer that can be checked against onsets, pitches and offsets, so it
 * can be benchmarked like any transcription system.
 *
 * The Teacher is aesthetic. Its question — *what would a music teacher fix?* —
 * has no single right answer.
 *
 * Merging them would destroy the only property that makes the first half
 * verifiable: we would no longer be able to tell whether the system understood
 * the recording or merely made it prettier.
 *
 * ## The original is always available
 *
 * `unprocessed` is not a debug view. Someone who hummed something deliberately
 * loose should be able to keep it, and every step away from it is offered
 * rather than imposed.
 */

import type { CreationMode, GridDivision } from '@contracts';
import type { RetouchParams } from '@retouch';
import { VERSION_ORDER, type MusicalVersionId } from '@versions';
import type { PerformanceRhythm } from './analyze';

/**
 * The id union now lives in `@versions`, which is the registry that knows what
 * a version *is* — including the two that arrive from the Musician service and
 * cannot be described by a retouch recipe.
 *
 * Re-exported under the old name so every existing call site keeps working; the
 * alternative was a rename touching two dozen files for no behavioural gain.
 */
export type VersionId = MusicalVersionId;

export const VERSION_IDS: readonly VersionId[] = VERSION_ORDER;

export type TempoSource = 'detected' | 'tapped';

export interface VersionRecipe {
  id: VersionId;
  /** The tempo this version is built on. */
  bpm: number;
  tempoSource: TempoSource;
  /** Value for the single Raw-to-Clean control. */
  amount: number;
  gridOverride?: GridDivision;
  /** Internal per-parameter overrides; see `resolveRetouchParams`. */
  paramOverrides?: Partial<Omit<RetouchParams, 'grid'>>;
}

export interface VersionPlanInput {
  rhythm: PerformanceRhythm;
  /** What the user tapped. Never discarded, always offered as "Grid". */
  tappedBpm: number;
  mode: CreationMode;
  /** The user's cleanup position, which still scales every version. */
  amount: number;
  /**
   * Which Musician versions actually have notes on this device.
   *
   * Empty is the normal case — the service is optional, may be disabled, and
   * may never have been asked. A version is only offered when its notes exist,
   * so the picker never shows something that cannot be played.
   */
  generated?: readonly MusicalVersionId[];
}

/**
 * Builds the set of versions to offer.
 *
 * Deterministic and pure: the same performance always produces the same menu,
 * which is what lets the review screen re-render without recomputing audio and
 * what makes the whole thing testable.
 */
export function planVersions(input: VersionPlanInput): VersionRecipe[] {
  const { rhythm, tappedBpm, amount, generated = [] } = input;
  const detected = rhythm.tempo.bpm;
  const useDetected = rhythm.reliable;
  const performanceBpm = useDetected ? detected : tappedBpm;
  const tempoSource: TempoSource = useDetected ? 'detected' : 'tapped';

  // How loose the performance actually was decides how much the Teacher has to
  // do. A steady performer barely needs pulling in; applying the same fixed
  // strength to everyone is how a good take gets flattened.
  const looseness = 1 - rhythm.groove.steadiness;
  const teacherTiming = clamp01(0.55 + looseness * 0.45);

  return [
    {
      // The transcription exactly as it arrived. No quantization, no scale
      // snapping, no dynamics flattening - the reference point everything else
      // is judged against.
      id: 'unprocessed',
      bpm: performanceBpm,
      tempoSource,
      amount: 0,
      paramOverrides: {
        timingStrength: 0,
        scaleSnapStrength: 0,
        velocitySmoothing: 0,
      },
    },
    {
      // The Judge's repair, played at the performance's own pulse. Timing is
      // barely touched: the Judge fixed *what* was played, and imposing a grid
      // here would start answering a different question.
      id: 'judge',
      bpm: performanceBpm,
      tempoSource,
      amount: Math.min(amount, 30),
      paramOverrides: {
        timingStrength: 0.15,
        scaleSnapStrength: 0,
        velocitySmoothing: 0.1,
      },
    },
    {
      // What a teacher would hand back: the same idea, put in time and in key.
      //
      // The musical work is done by `@music-teacher`, which has already moved
      // the notes it chose to move and recorded a reason for each. Retouch is
      // therefore kept light here - quantising on top of the Teacher's own
      // timing decisions would overwrite deliberate, explained choices with
      // an unexplained grid.
      id: 'teacher',
      bpm: performanceBpm,
      tempoSource,
      amount: Math.min(amount, 40),
      paramOverrides: {
        timingStrength: Math.min(0.35, teacherTiming * 0.4),
        scaleSnapStrength: 0,
        velocitySmoothing: 0.35,
      },
    },
    // The Musician's two readings, offered only when their notes exist.
    //
    // Retouch is at its lightest here, and deliberately lighter than the
    // Teacher's. These notes are the output of a model that made explicit,
    // recorded decisions about pitch and timing; quantising on top of them
    // would overwrite those decisions with an unexplained grid, and the
    // provenance we stored would then describe something the user never heard.
    //
    // Velocity smoothing is kept because it is a playback nicety rather than a
    // musical decision - it stops a synthesised line sounding mechanical
    // without moving a single note.
    ...MUSICIAN_RECIPE_IDS.filter((id) => generated.includes(id)).map<VersionRecipe>((id) => ({
      id,
      bpm: performanceBpm,
      tempoSource,
      amount: 0,
      paramOverrides: {
        timingStrength: 0,
        scaleSnapStrength: 0,
        velocitySmoothing: 0.25,
      },
    })),
  ];
}

/** Kept next to the recipes so a new Musician version cannot be added without one. */
const MUSICIAN_RECIPE_IDS: readonly MusicalVersionId[] = [
  'musician-refined',
  'musician-developed',
  'musician-expanded',
];

/** The version to select when the user has not chosen. */
export function defaultVersion(_rhythm: PerformanceRhythm): VersionId {
  // The Judge's reading is the honest default: it is the most faithful account
  // of what the person actually did, which is what they came to hear. The
  // Teacher is a step they choose to take, not one taken for them.
  return 'judge';
}

/**
 * Whether the detected and tapped tempos disagree enough to be worth saying.
 *
 * A half- or double-time relationship is the most common and the most
 * interesting: it usually means the user tapped eighths while singing quarters,
 * and telling them that is more useful than silently picking one.
 */
export interface TempoDisagreement {
  kind: 'none' | 'half-or-double' | 'different';
  detectedBpm: number;
  tappedBpm: number;
}

export function compareTempos(rhythm: PerformanceRhythm, tappedBpm: number): TempoDisagreement {
  const detected = rhythm.tempo.bpm;
  const base = { detectedBpm: detected, tappedBpm };
  if (!rhythm.reliable) return { ...base, kind: 'none' };

  const ratio = detected / tappedBpm;
  if (Math.abs(ratio - 1) < 0.06) return { ...base, kind: 'none' };
  if (Math.abs(ratio - 0.5) < 0.08 || Math.abs(ratio - 2) < 0.12) {
    return { ...base, kind: 'half-or-double' };
  }
  return { ...base, kind: 'different' };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
