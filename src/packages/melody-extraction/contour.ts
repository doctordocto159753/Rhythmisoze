import { isMeasuredOrigin, midiToFrequency, type FrameOrigin, type PitchFrame } from './pitch-tracker';

/**
 * How an uncertain gap is judged.
 *
 * The old rule was a frame count: bridge three frames (~30 ms), otherwise let
 * the note end. That is far too short for human humming, where a breath, a weak
 * consonant or an amplitude dip routinely costs 80-150 ms of clean tracking in
 * the middle of a single sustained note — and far too generous in the other
 * direction, because thirty milliseconds of anything gets bridged regardless of
 * what the audio was doing.
 *
 * So bridging asks for evidence instead of counting frames. The question is not
 * "how long was the gap" but "does the audio inside it look like the same note
 * continuing". Both matter, and the length only sets how much agreement is
 * required.
 */
export interface GapBridgeOptions {
  /** Never bridge longer than this, however good the evidence looks. */
  maxBridgeSec: number;
  /** Bridged without further argument below this, if the endpoints agree. */
  shortGapSec: number;
  /** How far the pitch either side of the gap may differ and still be one note. */
  endpointSemitones: number;
  /**
   * How far a candidate inside the gap may sit from the endpoints and still
   * count as agreeing with them.
   */
  interiorSemitones: number;
  /**
   * Fraction of in-gap frames that must carry an agreeing candidate before a
   * gap longer than `shortGapSec` is bridged.
   */
  interiorAgreement: number;
  /**
   * Energy inside the gap, relative to the quieter endpoint, below which the
   * gap is treated as true silence and never bridged.
   */
  silenceRatio: number;
}

export const DEFAULT_GAP_BRIDGE_OPTIONS: GapBridgeOptions = {
  maxBridgeSec: 0.22,
  shortGapSec: 0.05,
  endpointSemitones: 1.5,
  interiorSemitones: 1.5,
  interiorAgreement: 0.55,
  silenceRatio: 0.18,
};

export interface VocalRange {
  lowMidi: number;
  highMidi: number;
  centerMidi: number;
  label: string;
}

export interface SmoothedContour {
  frames: PitchFrame[];
  range: VocalRange | null;
}

const MIN_RANGE_FRAMES = 8;

/** Percentile range ignores phrase-edge flips instead of trusting extrema. */
export function detectAdaptiveVocalRange(frames: readonly PitchFrame[]): VocalRange | null {
  const pitches = frames
    .filter(
      (frame) =>
        frame.midiPitch !== null &&
        frame.confidence >= 0.68 &&
        isMeasuredOrigin(frame),
    )
    .map((frame) => frame.midiPitch as number)
    .sort((a, b) => a - b);
  if (pitches.length < MIN_RANGE_FRAMES) return null;
  const centerMidi = percentile(pitches, 0.5);
  const lowMidi = Math.max(24, percentile(pitches, 0.06) - 3);
  const highMidi = Math.min(108, percentile(pitches, 0.94) + 3);
  return {
    lowMidi,
    highMidi: Math.max(lowMidi + 1, highMidi),
    centerMidi,
    label: `${midiName(Math.round(lowMidi))}-${midiName(Math.round(highMidi))}`,
  };
}

/**
 * Confidence-weighted median smoothing plus octave-aware continuity repair.
 * The five-frame window is deliberately short: tracking grit disappears while
 * vibrato and intentional portamento remain continuous rather than quantized.
 */
export function smoothPitchContour(
  input: readonly PitchFrame[],
  bridgeOverrides: Partial<GapBridgeOptions> = {},
): SmoothedContour {
  if (input.length === 0) return { frames: [], range: null };
  const bridgeOptions = { ...DEFAULT_GAP_BRIDGE_OPTIONS, ...bridgeOverrides };
  const octaveRepaired = input.map((frame, index) => {
    if (frame.midiPitch === null) return { ...frame };
    const local = weightedMedian(
      input
        .slice(Math.max(0, index - 10), Math.min(input.length, index + 11))
        .filter((neighbor) => neighbor.midiPitch !== null && isMeasuredOrigin(neighbor))
        .map((neighbor) => ({
          value: neighbor.midiPitch as number,
          weight: Math.max(0.01, neighbor.confidence ** 2),
        })),
    );
    if (!Number.isFinite(local)) return { ...frame };
    const corrected = closestOctave(frame.midiPitch, local);
    // Only repair an octave-family error. Ordinary melodic leaps stay intact.
    const useCorrected =
      Math.abs(frame.midiPitch - local) > 6 &&
      Math.abs(corrected - local) + 4 < Math.abs(frame.midiPitch - local);
    // An untouched frame keeps its provenance verbatim; only a real rewrite
    // becomes a correction.
    return useCorrected && corrected !== frame.midiPitch
      ? withMidi(frame, corrected, 'corrected')
      : { ...frame };
  });

  const preliminaryRange = detectAdaptiveVocalRange(octaveRepaired);
  const ranged = octaveRepaired.map((frame) => {
    if (frame.midiPitch === null || preliminaryRange === null) return { ...frame };
    if (
      frame.midiPitch >= preliminaryRange.lowMidi &&
      frame.midiPitch <= preliminaryRange.highMidi
    ) {
      return { ...frame };
    }
    const folded = closestOctave(frame.midiPitch, preliminaryRange.centerMidi);
    if (folded >= preliminaryRange.lowMidi && folded <= preliminaryRange.highMidi) {
      return withMidi(frame, folded);
    }
    // Out of the singer's own range even after folding. The accepted pitch goes,
    // but `candidateMidi` stays: it is still what was measured, and refusing to
    // accept a reading is not the same as not having taken one.
    return {
      ...frame,
      frequencyHz: null,
      midiPitch: null,
      voiced: false,
      confidence: frame.confidence * 0.5,
    };
  });

  const smoothed = ranged.map((frame, index) => {
    if (frame.midiPitch === null) return { ...frame };
    const neighbors = ranged
      .slice(Math.max(0, index - 2), Math.min(ranged.length, index + 3))
      .filter((neighbor) => neighbor.midiPitch !== null && isMeasuredOrigin(neighbor))
      .map((neighbor) => ({
        value: neighbor.midiPitch as number,
        weight: Math.max(0.01, neighbor.confidence),
      }));
    if (neighbors.length < 2) return { ...frame };
    const median = weightedMedian(neighbors);
    // Identity passes through untouched; a moved value is a correction of a
    // measurement and keeps measurement's authority — smoothing never creates
    // inference, it only refines what was already heard.
    return median !== frame.midiPitch ? withMidi(frame, median, 'corrected') : { ...frame };
  });

  bridgeUncertainGaps(smoothed, hopSecOf(input), bridgeOptions);
  removeShortGlitches(smoothed, 3);
  repairSequentialOctaves(smoothed, preliminaryRange);
  return { frames: smoothed, range: detectAdaptiveVocalRange(smoothed) };
}

/**
 * Fills uncertain gaps that the evidence says are one note continuing.
 *
 * A gap is bridged when all of these hold:
 *
 *  - it is shorter than `maxBridgeSec` — beyond that, a listener hears two
 *    events however similar they are;
 *  - the pitch either side of it agrees to within `endpointSemitones`;
 *  - the energy inside it never falls to silence relative to the endpoints,
 *    because a genuine rest does;
 *  - and, for anything longer than `shortGapSec`, most of the frames inside it
 *    carry a *candidate* that agrees with the endpoints.
 *
 * That last condition is the one doing the real work, and it is only possible
 * because the tracker no longer discards its estimates. In the real take, a
 * sustained note dipping below the old confidence gate leaves ~150 ms of frames
 * whose candidates read 63.0-63.2 throughout; the noisy region a few seconds
 * later leaves frames reading 48, 60, 45, 55, 71, 43. Both look identical to a
 * frame-counting rule. They are not remotely alike here.
 *
 * What gets written is interpolation between the endpoint pitches — the
 * endpoints own the register, always. Interior candidates, including ones
 * sitting an octave flat of the truth, never become contour values: a
 * forensic pass showed that letting them do so handed subharmonic readings
 * segment authority and whole phrases landed an octave down. Bridged frames
 * are stamped `'interpolated'`, which every downstream decision point treats
 * as non-evidence: they extend duration and continuity, and influence nothing
 * else.
 */
function bridgeUncertainGaps(
  frames: PitchFrame[],
  hopSec: number,
  options: GapBridgeOptions,
): void {
  let index = 0;
  while (index < frames.length) {
    if (frames[index]?.midiPitch !== null) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < frames.length && frames[index]?.midiPitch === null) index += 1;
    const end = index;
    const before = frames[start - 1];
    const after = frames[end];
    if (
      before?.midiPitch === null ||
      before?.midiPitch === undefined ||
      after?.midiPitch === null ||
      after?.midiPitch === undefined
    ) {
      continue;
    }

    const gapSec = (end - start) * hopSec;
    if (gapSec > options.maxBridgeSec) continue;
    if (Math.abs(before.midiPitch - after.midiPitch) > options.endpointSemitones) continue;

    const anchor = (before.midiPitch + after.midiPitch) / 2;
    const interior = frames.slice(start, end);

    // Continuity of energy, at every frame rather than just the loudest one:
    // a tone that continues may dip, but it does not vanish. Measured against
    // the quieter endpoint so a quiet take is judged on its own terms. This is
    // what separates a tracking dropout inside one sustained note from the
    // near-silent articulation between two repeated notes — the latter must
    // stay two notes even when its candidates look agreeable.
    const edgeEnergy = Math.min(before.rms, after.rms);
    const floorEnergy = edgeEnergy * options.silenceRatio;
    if (edgeEnergy > 0 && !interior.every((frame) => frame.rms >= floorEnergy)) continue;

    /**
     * Octave-family agreement decides whether the hole looks like the same
     * note dropping out of tracking. On quiet material YIN reads the passing
     * tone a register down without the tone having gone anywhere, so strict
     * agreement would refuse holes the performer sang straight through. The
     * family reading counts as evidence only — the written values come from
     * the endpoints, so a bridge can close a hole without being able to move
     * a register.
     */
    const agreesWithAnchor = (candidate: number): boolean =>
      Math.abs(candidate - anchor) <= options.interiorSemitones ||
      Math.abs(Math.abs(candidate - anchor) - 12 * Math.round(Math.abs(candidate - anchor) / 12)) <=
        options.interiorSemitones;

    if (gapSec > options.shortGapSec) {
      const agreeing = interior.filter(
        (frame) => frame.candidateMidi !== null && agreesWithAnchor(frame.candidateMidi),
      ).length;
      if (agreeing / Math.max(1, interior.length) < options.interiorAgreement) continue;
    }

    // Half the quieter endpoint's confidence, well under the range-detection
    // floor, so inference cannot masquerade as confident listening even before
    // provenance filtering applies.
    const bridgedConfidence = Math.min(before.confidence, after.confidence) * 0.5;

    for (let cursor = start; cursor < end; cursor += 1) {
      const original = frames[cursor] as PitchFrame;
      const amount = (cursor - start + 1) / (end - start + 1);
      const interpolated = before.midiPitch + (after.midiPitch - before.midiPitch) * amount;
      frames[cursor] = withMidi(
        { ...original, confidence: bridgedConfidence },
        interpolated,
        'interpolated',
      );
    }
  }
}

function removeShortGlitches(frames: PitchFrame[], maxFrames: number): void {
  for (let index = 1; index < frames.length - 1; index += 1) {
    const current = frames[index];
    if (current?.midiPitch === null || current?.midiPitch === undefined) continue;
    let end = index + 1;
    while (
      end < frames.length &&
      frames[end]?.midiPitch !== null &&
      Math.abs((frames[end]?.midiPitch as number) - current.midiPitch) < 1
    ) {
      end += 1;
    }
    const before = frames[index - 1];
    const after = frames[end];
    if (
      end - index <= maxFrames &&
      before?.midiPitch !== null &&
      before?.midiPitch !== undefined &&
      after?.midiPitch !== null &&
      after?.midiPitch !== undefined &&
      Math.abs(before.midiPitch - after.midiPitch) <= 0.75 &&
      Math.abs(current.midiPitch - before.midiPitch) > 1.5
    ) {
      for (let cursor = index; cursor < end; cursor += 1) {
        frames[cursor] = withMidi(frames[cursor] as PitchFrame, before.midiPitch);
      }
    }
    index = end - 1;
  }
}

/**
 * Folds octave-family slips back toward the register the singer is actually in.
 *
 * ## Why the reference is a running median rather than the previous frame
 *
 * It used to be the previous frame, *after* that frame had itself been
 * repaired, which makes the repair self-reinforcing: fold one frame up an
 * octave and it becomes the reference that folds the next one up, and the whole
 * rest of the phrase ratchets. On the real take a genuine leap down from ~70 to
 * ~60 was read as an octave error, and the correction then walked the closing
 * phrase up through 72, 73, 75, 77, 81 — none of which was sung.
 *
 * A median over the last several accepted pitches cannot be moved by one frame,
 * so a mistaken fold corrects itself instead of compounding.
 *
 * ## Why the octave test is tight
 *
 * "Within three semitones of an octave" accepts every leap from a minor sixth
 * to a minor tenth as an octave error. Those are ordinary melodic intervals. A
 * real octave slip is a factor-of-two error in the period and lands within
 * about a semitone of twelve; the margin here is for intonation, not for
 * interval taste.
 */
const OCTAVE_ANCHOR_FRAMES = 9;

function repairSequentialOctaves(frames: PitchFrame[], range: VocalRange | null): void {
  const recent: number[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] as PitchFrame;
    if (frame.midiPitch === null) continue;
    // Inferred values never anchor and are never folded here. A bridged frame
    // carries the register its endpoints chose; feeding it into the running
    // median would let one filled hole bias how every neighbouring measured
    // frame is judged — the ratchet this function exists to prevent, rebuilt
    // from the inside.
    if (!isMeasuredOrigin(frame)) continue;
    if (recent.length > 0) {
      const anchor = medianOf(recent);
      const distance = Math.abs(frame.midiPitch - anchor);
      if (distance > 6) {
        const folded = closestOctave(frame.midiPitch, anchor);
        const octaveLike = Math.abs(distance - 12) <= 1.5;
        const insideRange =
          range === null || (folded >= range.lowMidi && folded <= range.highMidi);
        if (octaveLike && insideRange && Math.abs(folded - anchor) <= 4) {
          frames[index] = withMidi(frame, folded, 'corrected');
        }
      }
    }
    recent.push((frames[index] as PitchFrame).midiPitch as number);
    if (recent.length > OCTAVE_ANCHOR_FRAMES) recent.shift();
  }
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The frame spacing this contour was measured at. */
function hopSecOf(frames: readonly PitchFrame[]): number {
  const hops: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const hop = (frames[index]?.timeSec ?? 0) - (frames[index - 1]?.timeSec ?? 0);
    if (hop > 0) hops.push(hop);
  }
  hops.sort((a, b) => a - b);
  return hops[Math.floor(hops.length / 2)] ?? 0.01;
}

function closestOctave(pitch: number, target: number): number {
  let best = pitch;
  for (let shift = -3; shift <= 3; shift += 1) {
    const candidate = pitch + shift * 12;
    if (Math.abs(candidate - target) < Math.abs(best - target)) best = candidate;
  }
  return best;
}

function withMidi(frame: PitchFrame, midiPitch: number, origin?: FrameOrigin): PitchFrame {
  return {
    ...frame,
    midiPitch,
    frequencyHz: midiToFrequency(midiPitch),
    // A value rewrite on an existing measurement is a correction of that
    // measurement and keeps its authority. Filling a previously empty frame
    // creates inference; callers must say so explicitly via `origin`.
    origin: origin ?? frame.origin ?? 'corrected',
  };
}

function weightedMedian(items: ReadonlyArray<{ value: number; weight: number }>): number {
  const sorted = items
    .filter((item) => Number.isFinite(item.value) && item.weight > 0)
    .sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return Number.NaN;
  let accumulated = 0;
  for (const item of sorted) {
    accumulated += item.weight;
    if (accumulated >= total / 2) return item.value;
  }
  return sorted.at(-1)?.value ?? Number.NaN;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const amount = position - low;
  return (sorted[low] as number) * (1 - amount) + (sorted[high] as number) * amount;
}

function midiName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
