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
import type { TempoMode } from './tempo';

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

/**
 * The tempo of a performance, as an observation rather than a setting.
 *
 * ## What changed, and why it had to
 *
 * There used to be a second tempo in this file: the number the user set on the
 * metronome before recording. `resolveVersionTempo` arbitrated between the two,
 * and the whole product hung off that arbitration — the grid every version was
 * quantized to, the tempo the Musician was asked for, the exported MIDI.
 *
 * A user reported it plainly: the app said "heard at 85, but you selected 120",
 * and the music came out worse than when they had happened to select 85 before
 * singing the same phrase. That is a setup choice — made before there was any
 * music to have an opinion about — reaching into the interpretation of a
 * performance it could not possibly know anything about.
 *
 * There is no arbitration now because there is no second candidate. Tempo is
 * measured from the recording or it is not known, and "not known" is a real,
 * representable answer rather than a cue to substitute a number.
 *
 * ## Free timing is an answer
 *
 * `bpm: null` means the performance had no measurable pulse. Someone humming
 * rubato, hesitating, or singing four notes has not failed to provide a tempo;
 * they have provided material without one. The correct response is to leave the
 * timing exactly as performed, which is what `freeTiming` makes every consumer
 * do — see `encodingBpm` for the one place a number still has to appear, and
 * why appearing there does not make it musical truth.
 */
export interface PerformanceTempo {
  /** The measured pulse, or `null` when the performance had no measurable one. */
  bpm: number | null;
  /**
   * The estimator's confidence in the measurement, 0..1.
   *
   * Reported as measured. Uncertainty about a number is not evidence for a
   * different number, so a low value here hedges the presentation and never
   * nominates a substitute.
   */
  confidence: number;
  /** Whether `confidence` clears `TEMPO_CONFIDENCE_FLOOR`. */
  reliable: boolean;
  /** `true` exactly when `bpm` is null: the material is timed freely. */
  freeTiming: boolean;
  /**
   * What kind of timing this is.
   *
   * `freeTiming` is the boolean the rest of the product acts on; this says
   * *why* it is set, which is a different and more useful thing to show a
   * person. "No steady pulse here" and "there was nothing to measure" are both
   * free timing and they are not the same observation.
   */
  mode: TempoMode;
}

/**
 * The BPM written into a MIDI file, a bar ruler or a synthesis grid when the
 * performance itself has none.
 *
 * A MIDI file must state a tempo; a piano roll draws bar lines somewhere. Those
 * are encoding and drawing requirements, not musical claims, and the guide is
 * explicit that a technically required tempo value is not automatically the
 * musical truth. The value is a constant rather than a guess so that nothing
 * can mistake it for a measurement: it is the same 100 for every free-timed
 * take, it never varies with the audio, and every note keeps the absolute
 * second it was performed at regardless of it.
 *
 * The protection that makes this safe is `freeTiming` itself: no version
 * quantizes when it is set, so the grid this number implies is never applied to
 * anything.
 */
export const FREE_TIMING_ENCODING_BPM = 100;

/** The tempo to encode with, which is the measured one whenever there is one. */
export function encodingBpm(tempo: PerformanceTempo | null): number {
  return tempo?.bpm ?? FREE_TIMING_ENCODING_BPM;
}

export interface VersionRecipe {
  id: VersionId;
  /** The measured tempo this version is played at; null when freely timed. */
  bpm: number | null;
  /** See `PerformanceTempo.confidence`. Carried per version so the picker can hedge. */
  tempoConfidence: number;
  /** See `PerformanceTempo.reliable`. */
  tempoReliable: boolean;
  /** See `PerformanceTempo.freeTiming`. */
  freeTiming: boolean;
  /** Value for the single Raw-to-Clean control. */
  amount: number;
  gridOverride?: GridDivision;
  /** Internal per-parameter overrides; see `resolveRetouchParams`. */
  paramOverrides?: Partial<Omit<RetouchParams, 'grid'>>;
}

export interface TempoResolutionInput {
  rhythm: PerformanceRhythm | null;
  /**
   * A tempo the *source* stated about itself, if it stated one.
   *
   * Only a symbolic import can. A MIDI file carries a tempo map, and that is a
   * fact the file asserts about the music rather than a number somebody set on
   * a click track before performing — which is the distinction the whole of
   * this module now turns on.
   *
   * It outranks the measured pulse, and only here. Estimating a tempo from an
   * imported file's own note starts is deriving a worse answer to a question the
   * file has already answered exactly: on a 126 BPM file the estimator returned
   * 120, and the exported MIDI came back stamped with a tempo the source never
   * had. Detection exists for performances, where nothing states anything.
   */
  statedBpm?: number | null;
}

/**
 * What the performance says its tempo is.
 *
 * ```
 * the source stated its own tempo           -> that tempo, with certainty
 * a pulse was measured (at any confidence)  -> that pulse
 * no pulse could be measured at all         -> free timing
 * ```
 *
 * Only an imported file can take the first branch, and only because it holds a
 * tempo map. Nothing a *person* does can reach it: there is no control that
 * sets a tempo, which is the point of the whole change.
 *
 * `measured`, not `reliable`, decides. A measured-but-uncertain estimate is
 * still this performance's tempo; the only case where there is no performance
 * tempo is the one where none could be measured. Confidence is reported beside
 * the number so the interface can hedge, which is a different job from choosing.
 */
export function resolveVersionTempo(input: TempoResolutionInput): PerformanceTempo {
  const { rhythm, statedBpm } = input;
  const confidence = rhythm?.tempo.confidence ?? 0;

  if (statedBpm !== undefined && statedBpm !== null && Number.isFinite(statedBpm)) {
    // Certain, because it was not inferred. The file said so.
    return { bpm: statedBpm, confidence: 1, reliable: true, freeTiming: false, mode: 'stable' };
  }

  if (rhythm !== null && rhythm.measured) {
    return {
      bpm: rhythm.tempo.bpm,
      confidence,
      reliable: rhythm.reliable,
      freeTiming: false,
      mode: rhythm.tempo.mode,
    };
  }

  // Either nothing was measurable, or a winning grid existed but was not
  // distinguishable enough from its rivals to assert. Both are free timing as
  // far as every consumer is concerned; `mode` keeps the difference legible.
  return {
    bpm: null,
    confidence,
    reliable: false,
    freeTiming: true,
    mode: rhythm === null ? 'free' : rhythm.tempo.mode,
  };
}

export interface VersionPlanInput {
  rhythm: PerformanceRhythm;
  /** A tempo the source stated about itself. See `TempoResolutionInput`. */
  statedBpm?: number | null;
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
  const { rhythm, statedBpm, amount, mode, generated = [] } = input;
  // One rule, resolved once, applied to every version. Previously each recipe
  // read `rhythm.reliable` through a local ternary, which is how the tempo the
  // Musician was asked for and the tempo the versions played at could differ.
  const tempo = resolveVersionTempo({ rhythm, statedBpm });
  const performanceBpm = tempo.bpm;
  const tempoConfidence = tempo.confidence;
  const tempoReliable = tempo.reliable;
  const { freeTiming } = tempo;

  /**
   * Quantization strength, with free timing able to veto it.
   *
   * A take with no measurable pulse has no grid to be pulled onto. Applying one
   * anyway would mean inventing a tempo and then moving the person's notes to
   * fit it — the exact substitution this module was rewritten to remove, just
   * arriving through the encoding tempo instead of through the metronome.
   * `FREE_TIMING_ENCODING_BPM` still gets written into MIDI files and drawn as
   * bar lines, because those need a number; it never moves a note, because of
   * this.
   */
  const timing = (strength: number): number => (freeTiming ? 0 : strength);

  // How loose the performance actually was decides how much the Teacher has to
  // do. A steady performer barely needs pulling in; applying the same fixed
  // strength to everyone is how a good take gets flattened.
  const looseness = 1 - rhythm.groove.steadiness;
  const teacherTiming = clamp01(0.55 + looseness * 0.45);

  /**
   * Rhythm has two stages, not three.
   *
   * The three names come from the melody pipeline, where each one is a real and
   * separate question: did we hear the notes, did we understand them, what
   * would a teacher change. A rhythm has no second question. There is no
   * transcription verdict to render — an imported file has no transcription at
   * all — and no key or scale for a teacher to work on. What remains is timing
   * and dynamics, which is one transformation with a strength, and the strength
   * already has a control.
   *
   * So the Judge stage is omitted here rather than shown as a third reading
   * that differs from its neighbours only by an undisclosed 0.15. Offering
   * three stages when there are two is the picker claiming distinctions the
   * engine does not make.
   */
  return [
    {
      // The transcription exactly as it arrived. No quantization, no scale
      // snapping, no dynamics flattening - the reference point everything else
      // is judged against.
      id: 'unprocessed',
      bpm: performanceBpm,
      tempoConfidence,
      tempoReliable,
      freeTiming,
      amount: 0,
      paramOverrides: {
        timingStrength: 0,
        scaleSnapStrength: 0,
        velocitySmoothing: 0,
      },
    },
    // The Musician's readings, offered only when their notes exist.
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
      tempoConfidence,
      tempoReliable,
      freeTiming,
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
export function defaultVersion(
  _rhythm: PerformanceRhythm,
  _mode: CreationMode = 'melody',
): VersionId {
  // The transcription itself, because it is the most faithful account of what
  // the person actually did, and that is what they came to hear.
  //
  // There used to be two tidied readings between this and the Musician — a
  // Judge repair and a Teacher suggestion — and the default landed on the
  // first of them. Both removed the transcriber's own notes and flattened
  // pitches together, and because the Musician was fed the Teacher's output
  // rather than the take, every generated version inherited that. What the
  // model was asked to vary was no longer what the person sang.
  return 'unprocessed';
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
