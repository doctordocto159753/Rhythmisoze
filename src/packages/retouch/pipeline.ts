/**
 * The retouch pipeline - the layer the PRD calls the product's actual value.
 *
 * Takes raw transcriber output plus the tempo the user tapped, and returns
 * material that sounds intentional. Pure and deterministic: no clock, no
 * randomness, no I/O. That is what lets the UI re-run it on every slider move
 * and what lets the golden fixtures mean something.
 *
 * Stage order for melody, and why:
 *
 *   1. sort                  every downstream stage assumes ascending onsets
 *   2. octave filter         harmonics must go before they can skew the key
 *   3. key detection         run on the same set the Python reference uses
 *   4. merge / noise cleanup fragments must fuse before they are quantized,
 *                            otherwise each fragment claims its own grid step
 *   5. quantize (strength)   timing
 *   6. scale snap (strength) pitch
 *   7. velocity smoothing    dynamics
 *   8. playable-range clamp  keep the result inside the instrument
 *
 * Steps 3 and 5 both depend on the tempo, but on *different* tempos: the grid
 * uses `options.bpm`, which is the tempo of the version being built and is
 * decided by the caller — `resolveVersionTempo` in `@rhythm-extraction`, which
 * takes the performance's own pulse unless the user asked for the tapped value.
 * `estimateTempo` is run only to report back what the port heard, so a
 * discrepancy can be shown rather than silently producing a wrong grid.
 */

import type {
  CreationMode,
  DrumEvent,
  GridDivision,
  GridDrum,
  GridNote,
  KeyMode,
  MusicalKey,
  NoteEvent,
  PitchClassName,
  SketchAnalysis,
  SourceKind,
} from '@contracts';
import {
  clampToPlayableRange,
  mergeShortNotes,
  quantizeDrums,
  quantizeWithStrength,
  smoothVelocities,
  snapToScalePartial,
  toGridNotes,
} from './extensions';
import { resolveRetouchParams, stepSeconds, type RetouchParams } from './macro';
import {
  assessMelodyQuality,
  durationWeightedMedianPitch,
  type MelodyQualityAssessment,
} from './qualityGuard';
import {
  buildReport,
  detectKey,
  estimateTempo,
  quantize,
  sortNotes,
  stripOctaveErrors,
  type MusicalReport,
} from './port';

export interface RefineOptions {
  /**
   * The tempo this result is built on.
   *
   * No longer necessarily the tapped value: a version may supply the tempo
   * detected from the performance instead. See `rhythm-extraction/versions.ts`.
   */
  bpm: number;
  mode: CreationMode;
  /** The single Raw-to-Clean control, 0..100. */
  amount: number;
  /** Forces a grid instead of letting the macro choose one. */
  gridOverride?: GridDivision;
  /** User correction of the detected key (Q-B4). */
  keyOverride?: { root: PitchClassName; mode: KeyMode };
  /** Lowest and highest MIDI note the chosen instrument can voice. */
  playableRange?: { low: number; high: number };
  /** Independent monophonic contour used to prevent destructive cleanup. */
  referenceNotes?: readonly NoteEvent[];
  /** MIDI imports may be intentionally polyphonic/wide-register. */
  sourceKind?: SourceKind;
  /** Preserve and fidelity-process rhythm material beside pitched material. */
  preserveRhythm?: boolean;
  /**
   * Direct parameter overrides, used by the version presets so that timing and
   * pitch correction can move independently. Not reachable from the UI: the
   * user still has exactly one cleanup control.
   */
  paramOverrides?: Partial<Omit<RetouchParams, 'grid'>>;
}

export interface RefineResult {
  /** Final notes in seconds - what the synth plays and the MIDI file contains. */
  notes: NoteEvent[];
  /** Fully quantized view for the piano roll and the text grid. */
  gridNotes: GridNote[];
  drums: DrumEvent[];
  gridDrums: GridDrum[];
  stepSec: number;
  grid: GridDivision;
  key: MusicalKey;
  /**
   * `false` when the histogram was too flat or too sparse to mean anything.
   * The UI must not print a key the engine does not believe (US-0404).
   */
  keyIsReliable: boolean;
  report: MusicalReport;
  analysis: SketchAnalysis;
  params: RetouchParams;
  /** Null when there is no independent audio contour to compare against. */
  qualityGuard: MelodyQualityAssessment | null;
}

/**
 * Below this Krumhansl-Schmuckler correlation the detected key is treated as
 * unknown: scale snapping is skipped and the UI shows no key.
 *
 * Calibrated against the golden corpus rather than picked. Correlations there:
 *
 *   clearly tonal   0.59 - 0.84   (clean-melody, human-timing, octave-errors,
 *                                  sparse, single-note, duplicate-onsets)
 *   genuinely       0.34 - 0.40   (off-key, half-step-rounding)
 *   ambiguous
 *
 * 0.5 sits in the gap between the two groups. Moving it is a retouch behaviour
 * change and needs an ADR, not an edit.
 */
export const KEY_CONFIDENCE_FLOOR = 0.5;

/** A key result is only usable if the correlation is finite and convincing. */
export function isKeyReliable(key: MusicalKey, noteCount: number): boolean {
  return Number.isFinite(key.confidence) && key.confidence >= KEY_CONFIDENCE_FLOOR && noteCount >= 4;
}

export function refine(
  input: { notes: readonly NoteEvent[]; drums: readonly DrumEvent[] },
  options: RefineOptions,
): RefineResult {
  const params = resolveRetouchParams(options.amount, {
    grid: options.gridOverride,
    ...options.paramOverrides,
  });
  const stepSec = stepSeconds(options.bpm, params.grid);

  const resolved = { ...options, params, stepSec };
  if (options.mode === 'rhythm') return refineRhythm(input.drums, resolved);

  const melody = refineMelody(input.notes, resolved);
  if (!options.preserveRhythm || input.drums.length === 0) return melody;

  // Mixed material is two parallel responsibilities: Teacher/Musician shape
  // the pitched stream, while rhythm keeps the existing fidelity pipeline.
  const rhythm = refineRhythm(input.drums, resolved);
  return {
    ...melody,
    drums: rhythm.drums,
    gridDrums: rhythm.gridDrums,
    analysis: {
      ...melody.analysis,
      noteCount: melody.notes.length + rhythm.drums.length,
      notesMerged: melody.analysis.notesMerged + rhythm.analysis.notesMerged,
    },
  };
}

interface ResolvedOptions extends RefineOptions {
  params: RetouchParams;
  stepSec: number;
}

function refineMelody(rawNotes: readonly NoteEvent[], options: ResolvedOptions): RefineResult {
  const { params, stepSec } = options;
  const sorted = sortNotes(rawNotes);
  const reference = options.referenceNotes ?? [];
  const trustedCenter = durationWeightedMedianPitch(reference);

  const octaveFilterEnabled = params.octaveFilterEnabled && options.sourceKind !== 'midi-upload';
  const octave = octaveFilterEnabled
    ? stripOctaveErrors(sorted, params.octaveToleranceSemitones, trustedCenter)
    : { kept: sorted, dropped: 0 };

  // Key comes from the same note set the Python reference uses, before the
  // merge stage, so that a golden fixture at amount=100 still matches.
  const detected = detectKey(octave.kept);
  const reliable = isKeyReliable(detected, octave.kept.length);
  const key: MusicalKey = options.keyOverride
    ? { root: options.keyOverride.root, mode: options.keyOverride.mode, confidence: 1 }
    : detected;
  const keyIsReliable = options.keyOverride !== undefined || reliable;

  const cleaned = mergeShortNotes(octave.kept, {
    minDurationSec: params.mergeMinDurationSec,
    maxGapSec: params.mergeMaxGapSec,
    stepSec,
  });

  const timed = quantizeWithStrength(cleaned.notes, {
    stepSec,
    strength: params.timingStrength,
  });

  // A key nobody believes must not be used to move pitches around.
  const snapped = keyIsReliable
    ? snapToScalePartial(timed, key.root, key.mode, params.scaleSnapStrength)
    : { notes: timed.map((n) => ({ ...n })), moved: 0 };

  const dynamics = smoothVelocities(snapped.notes, params.velocitySmoothing);
  const playableRange = options.sourceKind === 'midi-upload' ? undefined : options.playableRange;
  let notes = playableRange
    ? clampToPlayableRange(dynamics, playableRange.low, playableRange.high)
    : dynamics;
  let qualityGuard =
    reference.length > 0 ? assessMelodyQuality(sorted, notes, reference) : null;

  if (qualityGuard?.triggered) {
    // Roll back pitch-destructive stages but retain the requested timing feel.
    // If even range folding harms the contour, the untouched monophonic path
    // wins; a clean-looking wrong melody is never preferable to the take.
    const timingOnly = quantizeWithStrength(sorted, {
      stepSec,
      strength: params.timingStrength,
    });
    const rangedTiming = playableRange
      ? clampToPlayableRange(timingOnly, playableRange.low, playableRange.high)
      : timingOnly;
    const safeAssessment = assessMelodyQuality(sorted, rangedTiming, reference);
    notes = safeAssessment.triggered ? sorted.map((note) => ({ ...note })) : rangedTiming;
    qualityGuard = {
      ...qualityGuard,
      cleanedAgreement: pitchAgreementForChosen(notes, reference),
    };
  }

  // The port's own quantize, at reference settings, drives the report so the
  // diagnostics stay comparable with the Python tool. This is a diagnostic
  // reading only: it never chooses the grid the notes are actually moved onto.
  const referenceGrid = quantize(octave.kept, options.bpm, params.grid / 4);
  const tempo = estimateTempo(octave.kept);
  const report = buildReport(
    rawNotes.length,
    octave.kept,
    octave.dropped,
    tempo,
    key,
    referenceGrid.notes,
  );

  const pitches = notes.map((n) => n.pitch);
  const analysis: SketchAnalysis = {
    keyRoot: key.root,
    keyMode: key.mode,
    keyConfidence: Number.isFinite(key.confidence) ? key.confidence : 0,
    detectedBpm: tempo.bpm,
    gridError: tempo.gridError,
    lowestPitch: pitches.length > 0 ? Math.min(...pitches) : 0,
    highestPitch: pitches.length > 0 ? Math.max(...pitches) : 0,
    noteCount: notes.length,
    octaveErrorsRemoved: octave.dropped,
    notesSnapped: snapped.moved,
    notesMerged: cleaned.merged + cleaned.removed,
    repeatedMovePercent: report.repeatedMovePercent,
    stepwiseMovePercent: report.stepwiseTotalPercent,
  };

  return {
    notes,
    gridNotes: toGridNotes(notes, stepSec),
    drums: [],
    gridDrums: [],
    stepSec,
    grid: params.grid,
    key,
    keyIsReliable,
    report,
    analysis,
    params,
    qualityGuard,
  };
}

function refineRhythm(rawDrums: readonly DrumEvent[], options: ResolvedOptions): RefineResult {
  const { params, stepSec } = options;
  const quantized = quantizeDrums(rawDrums, {
    stepSec,
    strength: params.timingStrength,
    // Only a detector can produce a duplicate detection. A file cannot: its
    // events are what somebody wrote, and two of them are two of them.
    mergeDuplicateDetections: options.sourceKind !== 'midi-upload',
  });

  const key: MusicalKey = { root: 'C', mode: 'major', confidence: 0 };
  const report = buildReport(
    rawDrums.length,
    [],
    0,
    { bpm: options.bpm, gridError: 0 },
    key,
    [],
  );

  const analysis: SketchAnalysis = {
    keyRoot: key.root,
    keyMode: key.mode,
    keyConfidence: 0,
    detectedBpm: options.bpm,
    gridError: 0,
    lowestPitch: 0,
    highestPitch: 0,
    noteCount: quantized.drums.length,
    octaveErrorsRemoved: 0,
    notesSnapped: 0,
    notesMerged: quantized.collisions,
    repeatedMovePercent: 0,
    stepwiseMovePercent: 0,
  };

  return {
    notes: [],
    gridNotes: [],
    drums: quantized.drums,
    gridDrums: quantized.gridDrums,
    stepSec,
    grid: params.grid,
    key,
    // Rhythm has no key. Saying so explicitly stops the UI from printing one.
    keyIsReliable: false,
    report,
    analysis,
    params,
    qualityGuard: null,
  };
}

function pitchAgreementForChosen(
  notes: readonly NoteEvent[],
  reference: readonly NoteEvent[],
): number {
  return assessMelodyQuality(notes, notes, reference).cleanedAgreement;
}
