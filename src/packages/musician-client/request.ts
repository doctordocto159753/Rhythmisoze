/**
 * Assembling a Musician request.
 *
 * Pulled out of the creation hook and made pure for one reason: the two facts
 * this payload has to get right are product invariants, and an invariant that
 * can only be checked by rendering a React tree is an invariant nobody checks.
 *
 *  1. **Teacher material, and only Teacher material** (AC-02). The notes are
 *     resolved through the same registry lookup every version goes through, so
 *     the claim is enforced by the code path rather than by this function
 *     remembering to be careful. There is no branch here that could reach the
 *     audio, and `MusicianRequest` has no field that could carry it (AC-03).
 *
 *  2. **The performance's tempo, at its real confidence.** Both halves of that
 *     used to be wrong. The bpm came from the metronome whenever detection
 *     confidence fell below 0.45, so a take measured at 88.5 BPM with confidence
 *     0.432 was submitted as the tapped 103 and the model built a passage on a
 *     grid the person never sang. The confidence was then reported as a
 *     hard-coded 0.4, which described neither number.
 *
 *     There is no metronome left to substitute, and this function still does
 *     not decide the tempo — `resolveVersionTempo` does. What it receives for a
 *     freely-timed take is the encoding constant paired with a confidence of
 *     zero: the service needs a number to condition on, and zero is the honest
 *     statement of how much that number means.
 */

import { notesForVersion, type VersionNoteSources } from '@versions';
import type { MusicianPhraseSpan, MusicianRequest } from './client';

export interface MusicianRequestInput {
  /** Identifies the sketch, so a result can be matched to it on return. */
  sourceId: string;
  /** Every version's notes. Only the Teacher's are read. */
  versionNotes: VersionNoteSources;
  /** Phrase spans in Teacher note indices. Empty for legacy/polyphonic input. */
  phrases?: readonly MusicianPhraseSpan[];
  /**
   * The tempo the music is interpreted at, with the estimator's own confidence.
   *
   * Not "the tempo, or the tapped one if we are unsure". A caller with only a
   * tapped tempo to offer must have resolved that explicitly first.
   */
  tempo: { bpm: number; confidence: number };
  meter: { beatsPerBar: number; beatUnit: number };
  key: { tonic: string; mode: 'major' | 'minor'; confidence: number } | null;
  /**
   * How long the *recording* is.
   *
   * Source evidence: the span the Teacher material occupies, and what the
   * service's Identity Guard measures a candidate against. It is not a length
   * budget for the result — Expanded is meant to exceed it.
   */
  sourceDurationSec: number;
  /** Omitted on a first attempt; set by "Try another" to force a new result. */
  seed?: number;
}

/**
 * The meter confidence sent with every request.
 *
 * The app does not detect meter; the user sets it, which is a strong signal.
 * The service refuses a meter it is not confident about rather than assuming
 * 4/4, so this has to be a real figure rather than a placeholder.
 */
const USER_SET_METER_CONFIDENCE = 0.8;

/** Null when there is no Teacher material to send. */
export function buildMusicianRequest(input: MusicianRequestInput): MusicianRequest | null {
  const notes = notesForVersion('teacher', input.versionNotes);
  if (!notes || notes.length === 0) return null;

  return {
    sourceId: input.sourceId,
    notes,
    phrases: (input.phrases ?? []).filter(
      (phrase) =>
        Number.isInteger(phrase.startIndex)
        && Number.isInteger(phrase.endIndex)
        && phrase.startIndex >= 0
        && phrase.endIndex >= phrase.startIndex
        && phrase.endIndex < notes.length,
    ),
    bpm: input.tempo.bpm,
    // Reported as measured. Uncertainty is information the service can weigh;
    // a substituted figure is not.
    tempoConfidence: input.tempo.confidence,
    meter: {
      numerator: input.meter.beatsPerBar,
      denominator: input.meter.beatUnit,
      confidence: USER_SET_METER_CONFIDENCE,
    },
    key: input.key,
    durationSec: input.sourceDurationSec,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  };
}
