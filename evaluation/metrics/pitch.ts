/**
 * Pitch evaluation metrics.
 *
 * The corpus answers one question per frame — *what did the human sing, and
 * what did we write down?* — in MIDI space, so every metric here works on
 * aligned frame pairs rather than raw audio. The definitions follow the MIR
 * tradition closely enough to be comparable, with one deliberate addition:
 * octave errors are reported separately instead of being folded into a single
 * accuracy number, because this product's dominant failure mode is a
 * confidently wrong octave, and an average would hide exactly that.
 *
 * All of these are computed against ground truth that exists because the
 * corpus synthesised it. Nothing here guesses at what a recording "really"
 * contained.
 */

/** One reference or estimated pitch observation. `midi === null` is unvoiced. */
export interface PitchObservation {
  timeSec: number;
  midi: number | null;
}

export interface PitchMetrics {
  /** Reference frames that were voiced, i.e. the denominator population. */
  referenceVoicedFrames: number;
  /** Share of reference-voiced frames where the estimate was also voiced. */
  voicingRecall: number;
  /**
   * Raw pitch accuracy: voiced reference frames where the estimate sits within
   * 50 cents. The strict "did we get the note" number.
   */
  rawPitchAccuracy: number;
  /**
   * Raw chroma accuracy: same tolerance modulo the octave. High RCA with low
   * RPA is the signature of register confusion, not of missing pitch.
   */
  rawChromaAccuracy: number;
  /**
   * Voiced reference frames where the estimate was exactly one octave away —
   * the failure mode that motivated this framework. Chroma right, register
   * wrong.
   */
  octaveErrorRate: number;
  /** Voiced reference frames where not even the chroma agreed. */
  grossErrorRate: number;
  /** Median absolute cent deviation across within-tolerance frames. */
  medianAbsoluteErrorCents: number;
}

const CENT_TOLERANCE = 50;

/**
 * Evaluates an estimated frame series against a reference series.
 *
 * Frames are matched by nearest time, never interpolated: an unvoiced gap is a
 * measurement ("nothing was accepted here") and inventing a pitch across it
 * would grade the estimator on fabrications.
 */
export function computePitchMetrics(
  reference: readonly PitchObservation[],
  estimate: readonly PitchObservation[],
): PitchMetrics {
  let referenceVoiced = 0;
  let voiced = 0;
  let pitchCorrect = 0;
  let chromaCorrect = 0;
  let octaveWrong = 0;
  const centDeviations: number[] = [];

  for (const refFrame of reference) {
    if (refFrame.midi === null) continue;
    referenceVoiced += 1;
    const estFrame = nearestByTime(estimate, refFrame.timeSec);
    if (!estFrame || estFrame.midi === null) continue;
    voiced += 1;

    // Modulo-octave distance in cents: how far apart the two readings are once
    // register disagreement is factored out.
    const cents = (estFrame.midi - refFrame.midi) * 100;
    const octaveRemainder = Math.abs(cents - Math.round(cents / 1200) * 1200);

    if (Math.abs(cents) <= CENT_TOLERANCE) {
      pitchCorrect += 1;
      chromaCorrect += 1;
      centDeviations.push(Math.abs(cents));
    } else if (octaveRemainder <= CENT_TOLERANCE) {
      chromaCorrect += 1;
      if (Math.abs(Math.abs(cents) - 1200) <= CENT_TOLERANCE * 4) octaveWrong += 1;
    }
  }

  return {
    referenceVoicedFrames: referenceVoiced,
    voicingRecall: ratio(voiced, referenceVoiced),
    rawPitchAccuracy: ratio(pitchCorrect, referenceVoiced),
    rawChromaAccuracy: ratio(chromaCorrect, referenceVoiced),
    octaveErrorRate: ratio(octaveWrong, referenceVoiced),
    grossErrorRate: ratio(referenceVoiced - chromaCorrect, referenceVoiced),
    medianAbsoluteErrorCents: median(centDeviations),
  };
}

export interface ReferenceNote {
  startSec: number;
  endSec: number;
  midi: number;
}

export interface NoteMetrics {
  referenceNotes: number;
  estimatedNotes: number;
  /** Matched notes / estimated notes. */
  precision: number;
  /** Matched notes / reference notes. */
  recall: number;
  f1: number;
  /** Median |estimated onset − true onset| across matches, in milliseconds. */
  medianOnsetErrorMs: number;
  /** Median absolute pitch error across matches, in semitones. */
  medianPitchErrorSemitones: number;
  /**
   * Direction agreement between consecutive intervals of matched notes: does
   * the transcription move the way the melody moved. 1 is perfect shape
   * fidelity on the surviving note stream; this is what makes a transcription
   * *singable* even where individual pitches drifted.
   */
  intervalDirectionAgreement: number;
}

/**
 * Note-level comparison. A match requires onset within `onsetToleranceSec`
 * and pitch within `pitchToleranceSemitones`; greedy earliest-first matching,
 * which is stable for the monophonic material this engine produces.
 */
export function computeNoteMetrics(
  reference: readonly ReferenceNote[],
  estimated: ReadonlyArray<{ startSec: number; endSec: number; pitch: number }>,
  onsetToleranceSec = 0.12,
  pitchToleranceSemitones = 1.0,
): NoteMetrics {
  const usedEstimated = new Set<number>();
  const matches: Array<{ ref: ReferenceNote; est: { startSec: number; endSec: number; pitch: number }; onsetDeltaMs: number }> = [];

  for (const refNote of reference) {
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    estimated.forEach((estNote, index) => {
      if (usedEstimated.has(index)) return;
      const delta = Math.abs(estNote.startSec - refNote.startSec);
      if (delta < bestDelta && delta <= onsetToleranceSec &&
          Math.abs(estNote.pitch - refNote.midi) <= pitchToleranceSemitones) {
        bestDelta = delta;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      usedEstimated.add(bestIndex);
      matches.push({
        ref: refNote,
        est: estimated[bestIndex] as { startSec: number; endSec: number; pitch: number },
        onsetDeltaMs: bestDelta * 1000,
      });
    }
  }

  // Interval direction agreement runs over the *reference* order restricted to
  // matched notes, comparing each consecutive pair's direction of motion.
  let intervalPairs = 0;
  let agreeing = 0;
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1] as (typeof matches)[number];
    const current = matches[index] as (typeof matches)[number];
    const refInterval = current.ref.midi - previous.ref.midi;
    const estInterval = current.est.pitch - previous.est.pitch;
    if (refInterval === 0 || estInterval === 0) continue;
    intervalPairs += 1;
    if (Math.sign(refInterval) === Math.sign(estInterval)) agreeing += 1;
  }

  const precision = ratio(matches.length, estimated.length);
  const recall = ratio(matches.length, reference.length);
  return {
    referenceNotes: reference.length,
    estimatedNotes: estimated.length,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    medianOnsetErrorMs: median(matches.map((m) => m.onsetDeltaMs)),
    medianPitchErrorSemitones: median(matches.map((m) => Math.abs(m.est.pitch - m.ref.midi))),
    intervalDirectionAgreement: ratio(agreeing, intervalPairs),
  };
}

function nearestByTime(
  observations: readonly PitchObservation[],
  timeSec: number,
): PitchObservation | null {
  if (observations.length === 0) return null;
  // The series are uniformly gridded; direct indexing beats scanning.
  const assumedHop =
    observations.length >= 2
      ? (observations[1] as PitchObservation).timeSec - (observations[0] as PitchObservation).timeSec
      : 0.01;
  const index = Math.round((timeSec - (observations[0] as PitchObservation).timeSec) / (assumedHop > 0 ? assumedHop : 0.01));
  return (observations[Math.max(0, Math.min(observations.length - 1, index))] ?? null);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
