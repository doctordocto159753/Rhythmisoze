/**
 * Turning a performance into rhythmic facts.
 *
 * The onsets a melody gives are not audio onsets — they are the note starts the
 * melody engine already found, which is strictly better information: they have
 * already survived voicing, contour smoothing and segmentation, so a vibrato
 * wobble or a breath is not mistaken for an attack.
 */

import type { DrumEvent, NoteEvent } from '@contracts';
import { analyzeGroove, type GrooveProfile } from './groove';
import {
  estimateMeter,
  estimatePerformanceTempo,
  TEMPO_CONFIDENCE_FLOOR,
  type MeterEstimate,
  type TempoEstimate,
  type TempoMode,
  type WeightedOnset,
} from './tempo';

/**
 * Below this groove steadiness, a believable pulse is still not a *steady* one.
 *
 * A performance can have a pulse that is genuinely there and genuinely moving —
 * accelerating into a phrase, relaxing at the end. Reporting that as `stable`
 * invites a caller to treat one number as a grid, which is the failure this
 * whole area is about, one level up.
 */
export const STEADY_GROOVE_FLOOR = 0.7;

export interface PerformanceRhythm {
  tempo: TempoEstimate;
  meter: MeterEstimate;
  groove: GrooveProfile;
  /**
   * `true` when there was enough of a performance to estimate a tempo at all.
   *
   * This — not `reliable` — is what decides whether the music has a pulse of its
   * own. A measured-but-uncertain estimate is still the performance's tempo; the
   * only case where the app has no performance tempo is the one where it could
   * not measure one.
   */
  measured: boolean;
  /**
   * `true` when the estimate is certain enough to state plainly as what the app
   * heard.
   *
   * A presentation and hedging signal, never a source-of-truth switch. See
   * `TEMPO_CONFIDENCE_FLOOR`.
   */
  reliable: boolean;
  onsetCount: number;
}

/**
 * Weight for a melodic onset.
 *
 * Longer notes and louder notes carry more rhythmic authority — a held note on
 * a downbeat tells you far more about the pulse than a passing sixteenth. Both
 * are compressed with a square root so one very long note cannot dominate.
 */
export function melodyOnsets(notes: readonly NoteEvent[]): WeightedOnset[] {
  return notes.map((note) => {
    const duration = Math.max(0.01, note.endSec - note.startSec);
    const lengthWeight = Math.sqrt(Math.min(duration, 2) / 2);
    const velocityWeight = Math.sqrt(Math.max(1, note.velocity) / 127);
    return {
      timeSec: note.startSec,
      weight: 0.35 + 0.4 * lengthWeight + 0.25 * velocityWeight,
    };
  });
}

/**
 * Weight for a percussive onset.
 *
 * A kick defines the pulse far more than a hat does, so the class matters more
 * than the length here — every drum hit is short.
 */
export function drumOnsets(drums: readonly DrumEvent[]): WeightedOnset[] {
  const classWeight: Record<string, number> = { kick: 1, snare: 0.85, hat: 0.45, unknown: 0.4 };
  return drums.map((drum) => ({
    timeSec: drum.timeSec,
    weight: (classWeight[drum.drum] ?? 0.5) * (0.5 + 0.5 * (drum.velocity / 127)),
  }));
}

export function analyzePerformanceRhythm(
  onsets: readonly WeightedOnset[],
  durationSec: number,
): PerformanceRhythm {
  const tempo = estimatePerformanceTempo(onsets, durationSec);
  const beatSec = 60 / Math.max(1, tempo.bpm);
  const meter = estimateMeter(onsets, tempo.beats, beatSec);
  const groove = analyzeGroove(onsets, tempo.bpm, tempo.phaseSec);
  // Steadiness is a property of the performance, and the estimator does not see
  // it — so the stable/variable distinction is settled here, where it does.
  const mode: TempoMode = !tempo.measured
    ? tempo.mode
    : groove.steadiness >= STEADY_GROOVE_FLOOR
      ? 'stable'
      : 'variable';

  return {
    tempo: { ...tempo, mode },
    meter,
    groove,
    measured: tempo.measured,
    reliable: tempo.measured && tempo.confidence >= TEMPO_CONFIDENCE_FLOOR,
    onsetCount: onsets.length,
  };
}

/** Convenience for the melody path. */
export function analyzeMelodyRhythm(
  notes: readonly NoteEvent[],
  durationSec: number,
): PerformanceRhythm {
  return analyzePerformanceRhythm(melodyOnsets(notes), durationSec);
}

/** Convenience for the beat path. */
export function analyzeDrumRhythm(
  drums: readonly DrumEvent[],
  durationSec: number,
): PerformanceRhythm {
  return analyzePerformanceRhythm(drumOnsets(drums), durationSec);
}
