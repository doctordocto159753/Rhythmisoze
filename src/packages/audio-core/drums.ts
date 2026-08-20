/**
 * US-0501 / US-0503 - beatbox taxonomy and classification.
 *
 * ## Approach and its provenance
 *
 * A transparent rule-based classifier over spectral features, not a learned
 * model. The story requires the training source to be documented and licensed
 * (US-0503); the product has no licensed beatbox corpus, and shipping a model
 * trained on unlicensed audio would be a real legal problem rather than a
 * theoretical one. Rules also have a property a small neural net does not: when
 * a user says "my snare came out as a kick", the reason is inspectable.
 *
 * ## The taxonomy
 *
 * Three classes plus `unknown`, per the MVP scope:
 *
 * | class | how a person makes it | what that leaves in the signal        |
 * |-------|-----------------------|---------------------------------------|
 * | kick  | lips, closed throat   | energy under 250 Hz, low centroid      |
 * | snare | "puh"/"psh", breathy  | broadband, high zero-crossing rate     |
 * | hat   | "ts"/"tss", teeth     | energy above 4 kHz, very short decay   |
 *
 * `unknown` is a real outcome, not a failure: an ambiguous stroke is voiced as a
 * closed hat (the least intrusive member of the kit) and flagged, rather than
 * being guessed into a kick that lands wrong on the downbeat.
 *
 * ## Evaluation
 *
 * Scored against the synthetic and recorded fixtures in `tests/fixtures`; the
 * method and results are recorded in `docs/benchmarks/rhythm-classifier.md`.
 * These weights are engineering defaults and are expected to move once a real
 * corpus exists - which is why they are one exported object rather than
 * constants sprinkled through the scoring function.
 */

import type { DrumClass, DrumEvent, OnsetEvent, OnsetFeatures } from '@contracts';

export interface DrumClassifierWeights {
  kick: { lowRatio: number; centroidHz: number; zcr: number; decaySec: number };
  snare: { lowRatio: number; centroidHz: number; zcr: number; decaySec: number };
  hat: { lowRatio: number; centroidHz: number; zcr: number; decaySec: number };
}

/**
 * Prototype feature vectors, one per class. Classification is nearest-prototype
 * in a normalised feature space - simple enough to reason about, and it
 * degrades gracefully instead of falling off a threshold cliff.
 */
export const DRUM_PROTOTYPES: DrumClassifierWeights = {
  kick: { lowRatio: 0.72, centroidHz: 320, zcr: 0.06, decaySec: 0.12 },
  snare: { lowRatio: 0.22, centroidHz: 2200, zcr: 0.24, decaySec: 0.09 },
  hat: { lowRatio: 0.05, centroidHz: 7200, zcr: 0.46, decaySec: 0.035 },
};

/**
 * Below this confidence the stroke is `unknown`. Set where the two best
 * prototypes are within roughly 15% of each other - i.e. the classifier has no
 * real opinion.
 */
export const DRUM_CONFIDENCE_FLOOR = 0.55;

/** Log-frequency distance, so 300 vs 600 Hz counts the same as 3 vs 6 kHz. */
function centroidDistance(a: number, b: number): number {
  const safeA = Math.max(20, a);
  const safeB = Math.max(20, b);
  return Math.abs(Math.log2(safeA / safeB)) / 5;
}

function distanceTo(
  features: OnsetFeatures,
  prototype: DrumClassifierWeights[keyof DrumClassifierWeights],
): number {
  const low = Math.abs(features.lowRatio - prototype.lowRatio);
  const centroid = centroidDistance(features.centroidHz, prototype.centroidHz);
  const zcr = Math.abs(features.zeroCrossingRate - prototype.zcr) / 0.5;
  const decay = Math.abs(features.decaySec - prototype.decaySec) / 0.2;
  // Weights: the low/high energy split separates kick from hat most reliably,
  // and zero-crossing rate is what distinguishes a breathy snare from either.
  return 0.38 * low + 0.3 * centroid + 0.22 * zcr + 0.1 * decay;
}

export interface Classification {
  drum: DrumClass;
  confidence: number;
  /** Per-class scores, kept so a mis-classification can be explained. */
  scores: Record<Exclude<DrumClass, 'unknown'>, number>;
}

export function classifyOnset(features: OnsetFeatures): Classification {
  const raw = {
    kick: distanceTo(features, DRUM_PROTOTYPES.kick),
    snare: distanceTo(features, DRUM_PROTOTYPES.snare),
    hat: distanceTo(features, DRUM_PROTOTYPES.hat),
  };

  // Turn distances into scores that sum to 1, so "confidence" means something
  // comparable across strokes rather than being an unbounded distance.
  const inverted = {
    kick: 1 / (raw.kick + 0.05),
    snare: 1 / (raw.snare + 0.05),
    hat: 1 / (raw.hat + 0.05),
  };
  const total = inverted.kick + inverted.snare + inverted.hat;
  const scores = {
    kick: inverted.kick / total,
    snare: inverted.snare / total,
    hat: inverted.hat / total,
  };

  const ranked = (Object.keys(scores) as Array<Exclude<DrumClass, 'unknown'>>).sort(
    (a, b) => scores[b] - scores[a],
  );
  const best = ranked[0] as Exclude<DrumClass, 'unknown'>;
  const second = ranked[1] as Exclude<DrumClass, 'unknown'>;

  // Confidence is the margin over the runner-up, rescaled to 0..1. A three-way
  // tie gives 0; a clear winner approaches 1.
  const margin = (scores[best] - scores[second]) / Math.max(scores[best], 1e-6);
  const confidence = Math.max(0, Math.min(1, 0.5 + margin));

  return {
    drum: confidence >= DRUM_CONFIDENCE_FLOOR ? best : 'unknown',
    confidence,
    scores,
  };
}

/** Maps detected onsets to drum events. Velocity comes from onset strength. */
export function classifyOnsets(onsets: readonly OnsetEvent[]): DrumEvent[] {
  return onsets.map((onset) => {
    const { drum, confidence } = classifyOnset(onset.features);
    return {
      timeSec: onset.timeSec,
      drum,
      velocity: strengthToVelocity(onset.strength),
      confidence,
    };
  });
}

/**
 * Onset strength (0..1 of the loudest hit in the clip) to MIDI velocity.
 * Floored at 45 so a quiet ghost note is still audible in the render, and
 * compressed at the top so one loud hit does not flatten everything else.
 */
export function strengthToVelocity(strength: number): number {
  const shaped = Math.sqrt(Math.max(0, Math.min(1, strength)));
  return Math.round(45 + shaped * 77);
}
