/**
 * Tempo, phase and meter recovered from the performance itself.
 *
 * ## Why this exists
 *
 * The first version treated the metronome as the source of truth: the user
 * tapped 120, and the grid became 120 regardless of what they actually sang.
 * That inverts the product. A click track is there to help someone perform
 * steadily; it is not a statement about the music they made. If a person taps
 * 120 and then sings at 83 because 83 is what the idea wanted, forcing the
 * result onto a 120 grid destroys the idea rather than tidying it.
 *
 * This module is now the *only* source of a tempo. The metronome, the tap pad
 * and the whole setup step they lived in are gone, so what is measured here is
 * not one option among several — it is the answer, and when there is nothing to
 * measure the answer is that the material has no pulse. See `versions.ts`.
 *
 * ## Why not the humtool estimator
 *
 * `estimateTempo` in the retouch port scores candidate tempos by how close
 * onsets fall to a 16th grid anchored at t=0. That has two flaws which are
 * exactly why the PRD measured it oscillating between 68, 84 and 174 BPM:
 *
 *  1. **It assumes phase zero.** A real take starts when the singer starts,
 *     not on a beat. An otherwise perfect performance offset by an eighth
 *     scores terribly, and some unrelated tempo wins by accident.
 *  2. **It has no octave preference.** Every grid that fits also fits at double
 *     and half speed, and a finer grid always fits at least as well, so the
 *     score alone pushes toward nonsense tempos.
 *
 * This module fixes both: phase is searched, and a perceptual resonance curve
 * breaks the half/double tie the way a listener would.
 *
 * The port keeps its own estimator untouched — it is verified against the
 * Python reference and must not drift (US-0401).
 */

import { BPM_MAX, BPM_MIN } from '@contracts';

export interface TempoCandidate {
  bpm: number;
  /** Seconds from the clip start to the first beat of the grid. */
  phaseSec: number;
  /** 0..1. How much of the onset weight lands on this grid. */
  salience: number;
}

export interface TempoEstimate {
  bpm: number;
  phaseSec: number;
  /**
   * Whether a pulse was actually found — not merely whether notes were counted.
   *
   * This used to be `true` for any take with four onsets and a positive
   * duration, which made it a statement about arithmetic rather than about
   * music. Every one of the nine benchmark recordings cleared that bar and was
   * given a precise BPM, while every one of them scored between 0.32 and 0.43
   * confidence — none reached the floor at which the interface is willing to
   * say the tempo plainly. The product was asserting a pulse it did not believe
   * in, on freely-sung material.
   *
   * It now requires `confidence >= TEMPO_CONFIDENCE_FLOOR`. Measured on
   * synthesised material, that boundary separates cleanly: metronomic input
   * scores 0.88–0.90, ±50 ms human jitter 0.77, ±90 ms 0.62, and the estimator
   * begins returning the *wrong* tempo at around 0.46 — at ±150 ms it reports
   * 81.5 BPM for a 100 BPM source. A performance with a pulse worth stating is
   * far above the floor; freely-timed singing is far below it.
   *
   * `false` means `bpm` is a placeholder, not a reading — and callers turn it
   * into free timing rather than into a number.
   */
  measured: boolean;
  /**
   * 0..1. Below `TEMPO_CONFIDENCE_FLOOR` the estimate is uncertain and the UI
   * must not present it as what the app definitely heard.
   *
   * Uncertainty about a measured number is not evidence for a different number.
   * A low value here says how loudly to hedge; it never nominates a substitute.
   */
  confidence: number;
  /** Beat times in seconds, covering the clip. */
  beats: number[];
  /** Runners-up, so a half/double disagreement can be shown rather than hidden. */
  alternatives: TempoCandidate[];
  /**
   * What kind of timing this is, rather than only how sure we are of a number.
   *
   * `confidence` answers "how much do we believe this BPM", which cannot say
   * the useful thing about a rubato performance: that a single global BPM is
   * the wrong shape of answer, not merely an uncertain one.
   */
  mode: TempoMode;
}

/**
 * How a performance is timed.
 *
 * - `free`     nothing periodic to measure — too few events, or no grid
 *              explains the material. `bpm` is null downstream.
 * - `uncertain` a candidate exists but is not distinguishable from its rivals
 *              well enough to assert. Also `bpm` null: an uncertain number
 *              presented as a tempo is worse than no tempo.
 * - `variable` a pulse is present and believable, but it moves. The BPM is an
 *              average, and callers should not treat it as a grid.
 * - `stable`   a pulse is present, believable and steady.
 */
export type TempoMode = 'free' | 'uncertain' | 'variable' | 'stable';

/**
 * Below this, the detected tempo is not certain enough to *present* as what the
 * app definitely heard, so the interface says "about" rather than stating it
 * flatly.
 *
 * A presentation threshold and nothing more. It was once a switch that swapped
 * in the tapped tempo — a take measured at 88.5 with confidence 0.432 was
 * played, exported and modelled at the tapped 103 because 0.432 missed 0.45 —
 * and there is no longer any second number for it to switch to. A performance
 * hummed at 88 is at 88 whether or not the estimator is sure of it.
 */
export const TEMPO_CONFIDENCE_FLOOR = 0.45;

/** Fewer onsets than this cannot establish a tempo at all. */
export const MIN_ONSETS = 4;

/**
 * Preferred tempo, in BPM, for the perceptual resonance curve.
 *
 * Around 100-120 BPM humans most readily perceive a pulse — the classic
 * "moderate tempo" preference reported by Parncutt and by Moelants. It is what
 * breaks the tie when a performance fits 80 and 160 equally well, and it is the
 * reason this estimator does not wander between half and double time.
 */
const PREFERRED_BPM = 110;
/** Width of the preference in octaves. Wider = weaker opinion. */
const RESONANCE_WIDTH = 0.9;

/**
 * How strongly a tempo is preferred for being perceptually plausible, 0..1.
 * A log-normal curve: symmetric in *ratio*, which is how tempo is heard.
 */
export function tempoResonance(bpm: number): number {
  const octavesAway = Math.log2(bpm / PREFERRED_BPM);
  return Math.exp(-(octavesAway * octavesAway) / (2 * RESONANCE_WIDTH * RESONANCE_WIDTH));
}

export interface TempoOptions {
  /** Search bounds. Defaults to the PRD's 40-200 range. */
  minBpm: number;
  maxBpm: number;
  /** Candidate spacing in BPM. */
  resolutionBpm: number;
  /**
   * How far from a beat an onset may sit and still count, as a fraction of the
   * beat. 0.18 is roughly a 32nd note at moderate tempo: tight enough to
   * discriminate, loose enough for a human.
   */
  toleranceRatio: number;
  /** Subdivisions an onset is allowed to land on. */
  subdivisions: number[];
}

export const DEFAULT_TEMPO_OPTIONS: TempoOptions = {
  minBpm: BPM_MIN,
  maxBpm: BPM_MAX,
  resolutionBpm: 0.5,
  toleranceRatio: 0.18,
  // A melody sits on beats, eighths and sixteenths; triplets are included so a
  // swung or compound performance is not forced onto a straight grid.
  subdivisions: [1, 2, 3, 4],
};

export interface WeightedOnset {
  timeSec: number;
  /** Relative importance, 0..1. Longer or louder events should weigh more. */
  weight: number;
}

/**
 * Estimates tempo and beat phase from weighted onsets.
 *
 * Pure and deterministic: the same onsets always produce the same tempo, which
 * is what makes it testable and what stops the result changing between two
 * renders of one sketch.
 */
export function estimatePerformanceTempo(
  onsets: readonly WeightedOnset[],
  durationSec: number,
  options: Partial<TempoOptions> = {},
): TempoEstimate {
  const config = { ...DEFAULT_TEMPO_OPTIONS, ...options };
  const usable = [...onsets]
    .filter((onset) => Number.isFinite(onset.timeSec) && onset.timeSec >= 0)
    .sort((a, b) => a.timeSec - b.timeSec);

  if (usable.length < MIN_ONSETS || durationSec <= 0) {
    // Nothing to measure. `bpm` is a neutral placeholder so the field is never
    // `NaN`, and `measured: false` is what stops any caller reading it as a
    // reading of the performance.
    return {
      bpm: PREFERRED_BPM,
      phaseSec: 0,
      measured: false,
      confidence: 0,
      beats: [],
      alternatives: [],
      mode: 'free',
    };
  }

  const totalWeight = usable.reduce((sum, onset) => sum + onset.weight, 0) || 1;
  const candidates: TempoCandidate[] = [];

  for (let bpm = config.minBpm; bpm <= config.maxBpm; bpm += config.resolutionBpm) {
    const beatSec = 60 / bpm;
    const { phaseSec, score } = bestPhaseFor(usable, beatSec, config, totalWeight);
    const coverage = beatCoverage(usable, beatSec, phaseSec, config.toleranceRatio);
    candidates.push({
      bpm,
      phaseSec,
      salience: score * tempoResonance(bpm) * coverage,
    });
  }

  candidates.sort((a, b) => b.salience - a.salience);
  const best = candidates[0] as TempoCandidate;
  const confidence = confidenceOf(candidates, usable.length);

  // The grid always produces a winner — there is always some BPM that fits
  // better than the others. That is not the same as the performance having a
  // pulse, and treating it as such is how freely-sung material acquired a
  // precise tempo it never had.
  const measured = confidence >= TEMPO_CONFIDENCE_FLOOR;
  const alternatives = distinctAlternatives(candidates, best);

  return {
    bpm: round1(best.bpm),
    phaseSec: best.phaseSec,
    measured,
    confidence,
    // The grid is still computed when the estimate is not assertable: callers
    // that want to *show* a candidate pulse can, and the alternatives keep a
    // half/double disagreement visible either way. What changes is that nothing
    // downstream treats it as the performance's tempo.
    beats: beatGrid(best.bpm, best.phaseSec, durationSec),
    alternatives,
    mode: measured ? 'stable' : 'uncertain',
  };
}

/**
 * What fraction of this tempo's beats actually have an event on them.
 *
 * This is what settles the half-versus-double question, and it settles it the
 * way a listener does. Steady events once a second fit a 60 BPM grid and a 120
 * BPM grid equally well — the difference is that at 120 every second beat is
 * silent. A pulse with nothing on half of its beats is a worse explanation of
 * the music than one where every beat is played, so it is scored as such.
 *
 * Measured across the span that actually contains onsets, so trailing silence
 * does not make every candidate look sparse.
 */
function beatCoverage(
  onsets: readonly WeightedOnset[],
  beatSec: number,
  phaseSec: number,
  toleranceRatio: number,
): number {
  const first = (onsets[0] as WeightedOnset).timeSec;
  const last = (onsets[onsets.length - 1] as WeightedOnset).timeSec;
  const span = last - first;
  if (span <= 0 || beatSec <= 0) return 1;

  const tolerance = beatSec * toleranceRatio;
  const firstBeatIndex = Math.ceil((first - phaseSec) / beatSec);
  const lastBeatIndex = Math.floor((last - phaseSec) / beatSec);
  const beatCount = lastBeatIndex - firstBeatIndex + 1;
  if (beatCount <= 1) return 1;

  let occupied = 0;
  for (let index = firstBeatIndex; index <= lastBeatIndex; index += 1) {
    const beatTime = phaseSec + index * beatSec;
    if (onsets.some((onset) => Math.abs(onset.timeSec - beatTime) <= tolerance)) occupied += 1;
  }
  return occupied / beatCount;
}

/**
 * The phase that puts the most onset weight on a grid of this tempo.
 *
 * Searched rather than assumed. Sixteen positions across the beat is enough
 * resolution that the winning phase is within a 64th note of correct, which is
 * finer than the tolerance window and therefore cannot change which onsets
 * count.
 */
function bestPhaseFor(
  onsets: readonly WeightedOnset[],
  beatSec: number,
  config: TempoOptions,
  totalWeight: number,
): { phaseSec: number; score: number } {
  const PHASE_STEPS = 16;
  let bestScore = -1;
  let bestPhase = 0;

  for (let step = 0; step < PHASE_STEPS; step += 1) {
    const phase = (step / PHASE_STEPS) * beatSec;
    let score = 0;

    for (const onset of onsets) {
      // How well this onset sits on *any* allowed subdivision of the beat.
      let bestFit = 0;
      for (const subdivision of config.subdivisions) {
        const stepSec = beatSec / subdivision;
        const offset = onset.timeSec - phase;
        const distance = Math.abs(offset - Math.round(offset / stepSec) * stepSec);
        const tolerance = stepSec * config.toleranceRatio * subdivision;
        if (tolerance <= 0) continue;
        // Linear falloff: dead on scores 1, at the tolerance edge scores 0.
        const fit = Math.max(0, 1 - distance / tolerance);
        // Coarser subdivisions are worth more, so a performance is not credited
        // for merely fitting a very fine grid that fits everything.
        const weightForSubdivision = 1 / Math.sqrt(subdivision);
        bestFit = Math.max(bestFit, fit * weightForSubdivision);
      }
      score += bestFit * onset.weight;
    }

    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  return { phaseSec: bestPhase, score: bestScore / totalWeight };
}

/**
 * How much to believe the winner.
 *
 * Two independent signals: how far ahead of the runner-up it is (a clear winner
 * means the performance really has that pulse), and how much evidence there was
 * (four onsets can agree by luck; twenty cannot).
 */
function confidenceOf(candidates: readonly TempoCandidate[], onsetCount: number): number {
  const best = candidates[0] as TempoCandidate;
  if (best.salience <= 0) return 0;

  // Compare against the best candidate that is not a near-neighbour or a
  // half/double of the winner: those agree with it rather than competing.
  const rival = candidates.find(
    (candidate) => !isSameTempoFamily(candidate.bpm, best.bpm) && !isNeighbour(candidate.bpm, best.bpm),
  );
  const margin = rival ? Math.max(0, (best.salience - rival.salience) / best.salience) : 1;

  const evidence = Math.min(1, (onsetCount - MIN_ONSETS + 1) / 10);
  // Absolute fit matters too: a performance nothing fits well should not score
  // high merely because nothing else fits either.
  return clamp01(best.salience * 0.45 + margin * 0.35 + evidence * 0.2);
}

/** Half, double, and the same tempo count as one family. */
export function isSameTempoFamily(a: number, b: number): boolean {
  const ratio = a / b;
  return [0.5, 1, 2].some((factor) => Math.abs(ratio - factor) < 0.06);
}

function isNeighbour(a: number, b: number): boolean {
  return Math.abs(a - b) <= 4;
}

/** The strongest candidates that are genuinely different tempos. */
function distinctAlternatives(
  candidates: readonly TempoCandidate[],
  best: TempoCandidate,
  limit = 2,
): TempoCandidate[] {
  const out: TempoCandidate[] = [];
  for (const candidate of candidates) {
    if (isNeighbour(candidate.bpm, best.bpm)) continue;
    if (out.some((chosen) => isNeighbour(chosen.bpm, candidate.bpm))) continue;
    out.push({ ...candidate, bpm: round1(candidate.bpm) });
    if (out.length >= limit) break;
  }
  return out;
}

export function beatGrid(bpm: number, phaseSec: number, durationSec: number): number[] {
  const beatSec = 60 / bpm;
  const beats: number[] = [];
  // Start at or before the first beat so a phase offset does not drop beat one.
  let time = phaseSec - Math.ceil(phaseSec / beatSec) * beatSec;
  while (time < 0) time += beatSec;
  for (; time <= durationSec + 1e-9; time += beatSec) beats.push(round6(time));
  return beats;
}

/**
 * Meter inference.
 *
 * Deliberately modest: it decides between duple and triple grouping by testing
 * which downbeat spacing best explains where the *strong* onsets fall. Anything
 * more ambitious needs harmony, which a hummed melody does not reliably give.
 */
export interface MeterEstimate {
  beatsPerBar: number;
  /** Index into `beats` of the first downbeat. */
  downbeatOffset: number;
  confidence: number;
}

export function estimateMeter(
  onsets: readonly WeightedOnset[],
  beats: readonly number[],
  beatSec: number,
): MeterEstimate {
  if (beats.length < 4 || onsets.length < MIN_ONSETS) {
    return { beatsPerBar: 4, downbeatOffset: 0, confidence: 0 };
  }

  // Weight landing on each beat, so grouping is tested against real accents.
  const beatWeights = beats.map((beatTime) => {
    let weight = 0;
    for (const onset of onsets) {
      if (Math.abs(onset.timeSec - beatTime) <= beatSec * 0.25) weight += onset.weight;
    }
    return weight;
  });

  let best = { beatsPerBar: 4, downbeatOffset: 0, confidence: 0, score: -1 };
  for (const beatsPerBar of [2, 3, 4, 6]) {
    for (let offset = 0; offset < beatsPerBar; offset += 1) {
      let onDownbeat = 0;
      let elsewhere = 0;
      beatWeights.forEach((weight, index) => {
        if ((index - offset + beatsPerBar * 8) % beatsPerBar === 0) onDownbeat += weight;
        else elsewhere += weight;
      });
      const bars = Math.max(1, beatWeights.length / beatsPerBar);
      // Mean weight per downbeat against mean weight per other beat: a real
      // meter puts more on the downbeat than chance would.
      const contrast =
        onDownbeat / bars - elsewhere / Math.max(1, beatWeights.length - bars);
      // A gentle preference for 4, which is overwhelmingly the common case and
      // stops a marginal signal from proposing 6 on a four-bar phrase.
      const score = contrast * (beatsPerBar === 4 ? 1.08 : 1);
      if (score > best.score) {
        best = { beatsPerBar, downbeatOffset: offset, confidence: 0, score };
      }
    }
  }

  const totalWeight = beatWeights.reduce((sum, weight) => sum + weight, 0) || 1;
  return {
    beatsPerBar: best.beatsPerBar,
    downbeatOffset: best.downbeatOffset,
    confidence: clamp01((best.score * beats.length) / totalWeight),
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
