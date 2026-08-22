/**
 * Measuring a corrected rhythm against the source it came from.
 *
 * ## Why event count is not enough
 *
 * A user's imported rhythm lost eight hits at the default cleanup, and the only
 * reason anyone noticed is that they counted the MIDI by hand. Counting is also
 * not sufficient: a hundred and forty-five events that have all been dragged
 * onto the wrong beats is a faithful count of an unfaithful rhythm. So there
 * are seven numbers, and they are kept apart because they fail in different
 * directions:
 *
 * ```
 * eventRetention        did every source event survive?
 * voiceRetention        did every rhythmic layer survive?
 * simultaneityRetention did hits that were together stay together?
 * onsetError            how far did correction move things?
 * velocityError         how much did it change the accents?
 * mergedEvents          how many events became part of another
 * deletedEvents         how many stopped existing entirely
 * ```
 *
 * Retention and onset error pull against each other: a correction that refuses
 * to move anything scores perfectly on one and does nothing, and one that
 * quantizes hard scores well on the other while flattening the groove. Reading
 * them together is the point.
 *
 * ## Matching by identity, not by proximity
 *
 * The obvious way to pair a corrected hit with its source is "the nearest one
 * of the same kind". That is wrong for exactly the material this exists to
 * measure: a rhythm repeats, so the nearest hit of a voice is frequently the
 * *next* hit of that voice rather than the same one, and the measurement then
 * reports a movement of half a second where nothing moved at all. Correction
 * carries `sourcePitch` and `voice` through, and hits within a voice keep their
 * order, so the pairing is positional within each voice and exact.
 */

import { drumVoiceOf, type DrumEvent } from '@contracts';

export interface RhythmFidelity {
  sourceEvents: number;
  correctedEvents: number;
  /** Fraction of source events still present as their own event, 0..1. */
  eventRetention: number;
  sourceVoices: number;
  correctedVoices: number;
  /** Fraction of source rhythmic layers that still exist, 0..1. */
  voiceRetention: number;
  /**
   * Fraction of source simultaneous groups whose members are still simultaneous
   * with each other, 0..1. A group of one counts as intact.
   */
  simultaneityRetention: number;
  /** Largest number of source events sharing an instant. */
  sourceMaxSimultaneity: number;
  correctedMaxSimultaneity: number;
  /** Seconds. `NaN` when nothing could be paired. */
  medianOnsetErrorSec: number;
  maxOnsetErrorSec: number;
  medianVelocityError: number;
  maxVelocityError: number;
  /** Source events folded into another event rather than kept. */
  mergedEvents: number;
  /** Source events that left no trace at all. */
  deletedEvents: number;
}

/** How close two onsets must be to count as the same instant. */
const SIMULTANEOUS_TOLERANCE_SEC = 0.005;

export function measureRhythmFidelity(
  source: readonly DrumEvent[],
  corrected: readonly DrumEvent[],
): RhythmFidelity {
  const sourceByVoice = groupByVoice(source);
  const correctedByVoice = groupByVoice(corrected);

  const onsetErrors: number[] = [];
  const velocityErrors: number[] = [];
  /** Source event -> its corrected counterpart, or null where it did not survive. */
  const pairing = new Map<DrumEvent, DrumEvent | null>();
  let deleted = 0;
  let merged = 0;

  for (const [voice, sourceHits] of sourceByVoice) {
    const correctedHits = correctedByVoice.get(voice) ?? [];
    if (correctedHits.length === 0) {
      // The whole layer is gone.
      for (const hit of sourceHits) pairing.set(hit, null);
      deleted += sourceHits.length;
      continue;
    }
    // Positional within the voice: correction may move a hit but never reorders
    // one past another of the same layer.
    for (let index = 0; index < sourceHits.length; index += 1) {
      const sourceHit = sourceHits[index] as DrumEvent;
      const match = correctedHits[index];
      if (match === undefined) {
        // Fewer survivors than sources in this layer: the tail was absorbed.
        pairing.set(sourceHit, null);
        merged += 1;
        continue;
      }
      pairing.set(sourceHit, match);
      onsetErrors.push(Math.abs(match.timeSec - sourceHit.timeSec));
      velocityErrors.push(Math.abs(match.velocity - sourceHit.velocity));
    }
  }

  const survived = [...pairing.values()].filter((value) => value !== null).length;

  return {
    sourceEvents: source.length,
    correctedEvents: corrected.length,
    eventRetention: source.length > 0 ? survived / source.length : 1,
    sourceVoices: sourceByVoice.size,
    correctedVoices: correctedByVoice.size,
    voiceRetention: sourceByVoice.size > 0 ? correctedByVoice.size / sourceByVoice.size : 1,
    simultaneityRetention: measureSimultaneity(source, pairing),
    sourceMaxSimultaneity: maxSimultaneity(source),
    correctedMaxSimultaneity: maxSimultaneity(corrected),
    medianOnsetErrorSec: median(onsetErrors),
    maxOnsetErrorSec: onsetErrors.length > 0 ? Math.max(...onsetErrors) : Number.NaN,
    medianVelocityError: median(velocityErrors),
    maxVelocityError: velocityErrors.length > 0 ? Math.max(...velocityErrors) : Number.NaN,
    mergedEvents: merged,
    deletedEvents: deleted,
  };
}

/**
 * How many groups of simultaneous source hits are still simultaneous.
 *
 * The question a listener would ask: the three things that landed together —
 * are they still one gesture, or has correction pulled them apart into three?
 * A group survives when every one of its members survived and they are all
 * still within the tolerance of each other.
 */
function measureSimultaneity(
  source: readonly DrumEvent[],
  pairing: ReadonlyMap<DrumEvent, DrumEvent | null>,
): number {
  const groups = simultaneousGroups(source);
  if (groups.length === 0) return 1;
  let intact = 0;
  for (const group of groups) {
    const matches = group.map((event) => pairing.get(event) ?? null);
    if (matches.some((match) => match === null)) continue;
    const times = matches.map((match) => (match as DrumEvent).timeSec);
    if (Math.max(...times) - Math.min(...times) <= SIMULTANEOUS_TOLERANCE_SEC) intact += 1;
  }
  return intact / groups.length;
}

function simultaneousGroups(events: readonly DrumEvent[]): DrumEvent[][] {
  const sorted = [...events].sort((a, b) => a.timeSec - b.timeSec);
  const groups: DrumEvent[][] = [];
  let current: DrumEvent[] = [];
  for (const event of sorted) {
    const first = current[0];
    if (first !== undefined && event.timeSec - first.timeSec <= SIMULTANEOUS_TOLERANCE_SEC) {
      current.push(event);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = [event];
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function maxSimultaneity(events: readonly DrumEvent[]): number {
  return Math.max(0, ...simultaneousGroups(events).map((group) => group.length));
}

function groupByVoice(events: readonly DrumEvent[]): Map<string, DrumEvent[]> {
  const byVoice = new Map<string, DrumEvent[]>();
  for (const event of [...events].sort((a, b) => a.timeSec - b.timeSec)) {
    const voice = drumVoiceOf(event);
    const existing = byVoice.get(voice);
    if (existing) existing.push(event);
    else byVoice.set(voice, [event]);
  }
  return byVoice;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
