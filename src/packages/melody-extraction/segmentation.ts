import type { PitchFrame } from './pitch-tracker';

export interface MelodySegment {
  startSec: number;
  endSec: number;
  midiPitch: number;
  confidence: number;
  intensity: number;
}

export interface SegmentationOptions {
  pitchChangeSemitones: number;
  stableFrames: number;
  maxGapFrames: number;
  minDurationSec: number;
  /**
   * The register the contour measured this singer in, when one was established.
   *
   * Used only to refuse an octave repair that would place a note outside it.
   * Null means no opinion, which is the honest state for a take too short to
   * establish a range.
   */
  register: SegmentRegister | null;
}

export const DEFAULT_SEGMENTATION_OPTIONS: SegmentationOptions = {
  pitchChangeSemitones: 0.85,
  stableFrames: 5,
  // Raised from five. It used to be the only defence against a note being cut
  // by a momentary tracking dropout, and fifty milliseconds is nowhere near
  // enough for that job — a breath or a weak consonant costs more than that
  // routinely. It is no longer doing that job: the contour now decides, from
  // the evidence inside a gap, whether the gap is one note continuing. What is
  // left here is a backstop for gaps that bridging looked at and declined, and
  // for those a short tolerance is right.
  maxGapFrames: 8,
  minDurationSec: 0.1,
  register: null,
};

/** Converts a continuous contour into stable, expressive note regions. */
export function segmentPitchContour(
  frames: readonly PitchFrame[],
  overrides: Partial<SegmentationOptions> = {},
): MelodySegment[] {
  const options = { ...DEFAULT_SEGMENTATION_OPTIONS, ...overrides };
  if (frames.length === 0) return [];
  const hopSec = medianHop(frames);
  const segments: MelodySegment[] = [];
  let current: PitchFrame[] = [];
  let pending: PitchFrame[] = [];
  let lastVoicedIndex = -1;

  const closeCurrent = (endSec?: number): void => {
    if (current.length === 0) return;
    const startSec = current[0]?.timeSec ?? 0;
    const naturalEnd = (current.at(-1)?.timeSec ?? startSec) + hopSec;
    const segment = buildSegment(current, startSec, Math.max(startSec + hopSec, endSec ?? naturalEnd));
    if (segment) segments.push(segment);
    current = [];
    pending = [];
  };

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] as PitchFrame;
    if (frame.midiPitch === null) {
      if (current.length > 0 && index - lastVoicedIndex > options.maxGapFrames) {
        closeCurrent((frames[lastVoicedIndex]?.timeSec ?? frame.timeSec) + hopSec);
      }
      pending = [];
      continue;
    }
    lastVoicedIndex = index;
    if (current.length === 0) {
      current = [frame];
      continue;
    }

    // Where this note has settled, not the average of everywhere it has been.
    //
    // Bounded to the recent past for two reasons. It is asked once per frame
    // and searches for a cluster, so an unbounded window makes a long note
    // quadratic in its own length; and a note held for four seconds should be
    // judged against the pitch it is on now, not against a mode that includes
    // where it was three seconds ago. The window is long enough to contain a
    // whole slide, so a portamento still resolves to the pitch it left rather
    // than to the middle of the journey.
    const currentPitch = settledPitch(current.slice(-CHANGE_REFERENCE_FRAMES));
    if (Math.abs(frame.midiPitch - currentPitch) < options.pitchChangeSemitones) {
      if (pending.length > 0) current.push(...pending);
      pending = [];
      current.push(frame);
      continue;
    }

    const pendingCenter = pending.length > 0 ? weightedMedianPitch(pending) : frame.midiPitch;
    if (pending.length > 0 && Math.abs(frame.midiPitch - pendingCenter) > 0.65) {
      // A moving target is portamento/glitch, not a stable new note yet.
      current.push(...pending);
      pending = [frame];
    } else {
      pending.push(frame);
    }

    if (pending.length >= options.stableFrames && pitchSpread(pending) <= 0.8) {
      const boundary = pending[0]?.timeSec ?? frame.timeSec;
      closeCurrent(boundary);
      current = pending;
      pending = [];
    }
  }
  if (pending.length > 0) current.push(...pending);
  closeCurrent();

  return stabilizeSegmentOctaves(
    consolidateSegments(segments, options.minDurationSec),
    options.register,
  );
}

/**
 * Resolves remaining octave-family errors at the musical-event level. Stable,
 * high-confidence notes anchor each phrase; weaker neighbours may move by an
 * octave to reach that contour. Working after segmentation prevents a long
 * false bass activation from winning merely because it produced more frames.
 */
export function stabilizeSegmentOctaves(
  input: readonly MelodySegment[],
  range: SegmentRegister | null = null,
): MelodySegment[] {
  const segments = input.map((segment) => ({ ...segment }));
  let groupStart = 0;
  while (groupStart < segments.length) {
    let groupEnd = groupStart + 1;
    while (
      groupEnd < segments.length &&
      (segments[groupEnd]?.startSec ?? 0) - (segments[groupEnd - 1]?.endSec ?? 0) <= 0.5
    ) {
      groupEnd += 1;
    }
    let anchor = groupStart;
    let anchorScore = -1;
    for (let index = groupStart; index < groupEnd; index += 1) {
      const segment = segments[index] as MelodySegment;
      const duration = Math.max(0.01, segment.endSec - segment.startSec);
      // A tiny upper-register tie-breaker prevents a persistent subharmonic
      // from defeating an equally clear perceived fundamental. Confidence and
      // stability still dominate; pitch contributes at most a few hundredths.
      const score = segment.confidence ** 4 * duration ** 0.25 + segment.midiPitch * 0.002;
      if (score > anchorScore) {
        anchorScore = score;
        anchor = index;
      }
    }
    // The reference is the median of everything already settled in this group,
    // not the immediately preceding segment. Chaining through the neighbour is
    // what let one wrong fold become the basis of the next; a median needs a
    // majority to move and so cannot be walked by a single mistake.
    const settled: number[] = [(segments[anchor] as MelodySegment).midiPitch];
    for (let index = anchor - 1; index >= groupStart; index -= 1) {
      const segment = segments[index] as MelodySegment;
      segment.midiPitch = octaveCandidate(segment.midiPitch, medianOf(settled), range);
      settled.push(segment.midiPitch);
    }
    for (let index = anchor + 1; index < groupEnd; index += 1) {
      const segment = segments[index] as MelodySegment;
      segment.midiPitch = octaveCandidate(segment.midiPitch, medianOf(settled), range);
      settled.push(segment.midiPitch);
    }
    // A second reference, and the reason it exists: the anchor is one segment,
    // and the walk above judges the segment next to it against that one alone.
    // A phrase whose anchor sits a seventh above its own centre — a clear high
    // note in an otherwise low line — therefore fails to repair its neighbour,
    // and the neighbour is then in the median for everything after it.
    //
    // Once the walk has settled, the phrase's own centre is known, so the same
    // test is applied against that. Two rounds is enough for every fixture
    // here; the loop stops as soon as nothing moves, so it cannot oscillate.
    for (let round = 0; round < 2; round += 1) {
      const centre = medianOf(
        segments.slice(groupStart, groupEnd).map((segment) => segment.midiPitch),
      );
      let moved = false;
      for (let index = groupStart; index < groupEnd; index += 1) {
        // Never the anchor. It was chosen as the segment least likely to be
        // wrong, and a phrase built around a clear high note would otherwise
        // pull that note down to meet the subharmonics it exists to correct.
        if (index === anchor) continue;
        const segment = segments[index] as MelodySegment;
        const repaired = octaveCandidate(segment.midiPitch, centre, range);
        if (repaired !== segment.midiPitch) {
          segment.midiPitch = repaired;
          moved = true;
        }
      }
      if (!moved) break;
    }
    groupStart = groupEnd;
  }
  return segments;
}

/**
 * How far one segment may sit from the phrase around it before the distance is
 * better explained by the tracker than by the singer.
 *
 * It used to be 7.5 semitones — a tritone. A minor sixth is eight semitones and
 * a minor seventh is ten; both are ordinary things to sing, and both were being
 * "corrected" an octave upward. Worse, the corrected value then became the
 * reference for the next segment, so the correction walked: the real take ends
 * on a phrase whose contour reads 60, 61, 62, 65, 67, 69 and which came out as
 * 72, 73, 75, 77, 81, 82 — every interval preserved, the whole thing an octave
 * and a half above anything the person hummed.
 *
 * The threshold itself is unchanged — a hummed line really does stay inside a
 * tritone of itself most of the time, and the recordings this was calibrated on
 * still need that. What changed is everything around it: the reference is now a
 * median of the segments already settled rather than the immediately preceding
 * one, and a fold may not push a segment outside the register the singer was
 * measured in. Together those stop one debatable fold from becoming six.
 */
const MELODIC_LEAP_LIMIT = 7.5;

/** The register the singer was measured in, so a repair cannot leave it. */
export interface SegmentRegister {
  lowMidi: number;
  highMidi: number;
}

function octaveCandidate(
  pitch: number,
  reference: number,
  range: SegmentRegister | null,
): number {
  if (Math.abs(pitch - reference) <= MELODIC_LEAP_LIMIT) return pitch;
  // One octave at a time. Two would let a badly-tracked segment jump straight
  // to whichever register happened to be closest, which is how a phrase built
  // from subharmonics ends up two octaves above the singer instead of one.
  let best = pitch;
  for (let shift = -1; shift <= 1; shift += 1) {
    const candidate = pitch + shift * 12;
    if (
      candidate >= 24 &&
      candidate <= 108 &&
      Math.abs(candidate - reference) < Math.abs(best - reference)
    ) {
      best = candidate;
    }
  }
  if (Math.abs(best - reference) > MELODIC_LEAP_LIMIT) return pitch;
  // A repair that lands outside the register this person actually sang in is
  // not a repair. The unfolded value may be wrong, but it is at least a
  // measurement; the folded one would be an invention above their range.
  if (range !== null && (best < range.lowMidi || best > range.highMidi)) return pitch;
  return best;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function buildSegment(
  frames: readonly PitchFrame[],
  startSec: number,
  endSec: number,
): MelodySegment | null {
  const pitched = frames.filter((frame) => frame.midiPitch !== null);
  if (pitched.length === 0 || endSec <= startSec) return null;
  const confidenceWeight = pitched.reduce((sum, frame) => sum + frame.confidence, 0);
  return {
    startSec,
    endSec,
    midiPitch: settledPitch(pitched),
    confidence: clamp01(confidenceWeight / pitched.length),
    intensity: Math.max(...pitched.map((frame) => frame.rms)),
  };
}

/**
 * How close a neighbour must be, in seconds, to absorb a too-short segment.
 *
 * Absorbing used to be unconditional: a segment below the minimum duration was
 * folded into whichever neighbour was nearest *in pitch*, however far away it
 * was in time. On the real take a single spurious frame at 3.36 s was absorbed
 * by the next real note at 5.13 s, and the result was a 2.5 second note over a
 * second and three quarters of silence.
 *
 * A fragment is only part of its neighbour if it is adjacent to it. Otherwise
 * it is a fragment of nothing and is dropped, which is what "too short to be a
 * note" was supposed to mean in the first place.
 */
const ABSORB_GAP_SEC = 0.12;

function consolidateSegments(
  input: readonly MelodySegment[],
  minDurationSec: number,
): MelodySegment[] {
  const segments = input.map((segment) => ({ ...segment }));
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as MelodySegment;
    if (segment.endSec - segment.startSec >= minDurationSec) continue;
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const previousDistance =
      previous && segment.startSec - previous.endSec <= ABSORB_GAP_SEC
        ? Math.abs(previous.midiPitch - segment.midiPitch)
        : Number.POSITIVE_INFINITY;
    const nextDistance =
      next && next.startSec - segment.endSec <= ABSORB_GAP_SEC
        ? Math.abs(next.midiPitch - segment.midiPitch)
        : Number.POSITIVE_INFINITY;
    if (previous && previousDistance <= nextDistance && Number.isFinite(previousDistance)) {
      previous.endSec = Math.max(previous.endSec, segment.endSec);
      previous.confidence = Math.max(previous.confidence, segment.confidence);
      previous.intensity = Math.max(previous.intensity, segment.intensity);
    } else if (next && Number.isFinite(nextDistance)) {
      next.startSec = Math.min(next.startSec, segment.startSec);
    }
    // Neither neighbour is adjacent: the fragment stands alone and is dropped.
    segments.splice(index, 1);
    index -= 1;
  }

  const merged: MelodySegment[] = [];
  for (const segment of segments) {
    const pitch = Math.round(segment.midiPitch);
    const previous = merged.at(-1);
    if (
      previous &&
      Math.round(previous.midiPitch) === pitch &&
      segment.startSec - previous.endSec <= 0.08
    ) {
      previous.endSec = Math.max(previous.endSec, segment.endSec);
      previous.confidence = Math.max(previous.confidence, segment.confidence);
      previous.intensity = Math.max(previous.intensity, segment.intensity);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/** How close two frames must be to count as sitting on the same pitch. */
const SETTLE_WINDOW_SEMITONES = 0.6;

/** How much of the note in progress the change test looks back over. */
const CHANGE_REFERENCE_FRAMES = 120;

/**
 * The pitch a run of frames settled on.
 *
 * ## Why not the median of all of them
 *
 * A note that ends in a slide contains two different things: the pitch that was
 * sung, and the journey away from it. A plain median mixes them, and the more of
 * the slide the segment holds the further the reported pitch drifts from
 * anything the person actually held. On the real take a G4 moving to F4 was
 * reported as the F#4 between them — a note that was passed through, never sung.
 *
 * So this looks for the largest cluster of frames sitting on one pitch and
 * reports that, weighted by confidence. A slide contributes many frames but no
 * cluster, because it never stays anywhere; a held note contributes one large
 * cluster, which wins. Vibrato and slow drift are clusters too — they stay
 * within the window — so both are still reported as the single note they are.
 *
 * Used for the change test as well as for the segment's own pitch, so "has the
 * pitch moved?" is asked against what is actually sounding rather than against
 * a running average that the move itself is dragging.
 */
export function settledPitch(frames: readonly PitchFrame[]): number {
  const pitched = frames.filter((frame) => frame.midiPitch !== null);
  if (pitched.length === 0) return Number.NaN;
  if (pitched.length <= 2) return weightedMedianPitch(pitched);

  let best: readonly PitchFrame[] = pitched;
  let bestWeight = -1;
  for (const centre of pitched) {
    const cluster = pitched.filter(
      (frame) =>
        Math.abs((frame.midiPitch as number) - (centre.midiPitch as number)) <=
        SETTLE_WINDOW_SEMITONES,
    );
    const weight = cluster.reduce((sum, frame) => sum + Math.max(0.01, frame.confidence), 0);
    if (weight > bestWeight) {
      bestWeight = weight;
      best = cluster;
    }
  }
  return weightedMedianPitch(best);
}

function weightedMedianPitch(frames: readonly PitchFrame[]): number {
  const values = frames
    .filter((frame) => frame.midiPitch !== null)
    .map((frame) => ({ value: frame.midiPitch as number, weight: Math.max(0.01, frame.confidence) }))
    .sort((a, b) => a.value - b.value);
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  let accumulated = 0;
  for (const item of values) {
    accumulated += item.weight;
    if (accumulated >= total / 2) return item.value;
  }
  return values.at(-1)?.value ?? Number.NaN;
}

function pitchSpread(frames: readonly PitchFrame[]): number {
  const values = frames
    .map((frame) => frame.midiPitch)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length < 2) return 0;
  return percentile(values, 0.9) - percentile(values, 0.1);
}

function medianHop(frames: readonly PitchFrame[]): number {
  const hops: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const hop = (frames[index]?.timeSec ?? 0) - (frames[index - 1]?.timeSec ?? 0);
    if (hop > 0) hops.push(hop);
  }
  hops.sort((a, b) => a - b);
  return hops[Math.floor(hops.length / 2)] ?? 0.01;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const amount = position - low;
  return (sorted[low] as number) * (1 - amount) + (sorted[high] as number) * amount;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
