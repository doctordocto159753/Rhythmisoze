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
}

export const DEFAULT_SEGMENTATION_OPTIONS: SegmentationOptions = {
  pitchChangeSemitones: 0.85,
  stableFrames: 5,
  maxGapFrames: 5,
  minDurationSec: 0.1,
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

    const currentPitch = weightedMedianPitch(current);
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

  return stabilizeSegmentOctaves(consolidateSegments(segments, options.minDurationSec));
}

/**
 * Resolves remaining octave-family errors at the musical-event level. Stable,
 * high-confidence notes anchor each phrase; weaker neighbours may move by an
 * octave to reach that contour. Working after segmentation prevents a long
 * false bass activation from winning merely because it produced more frames.
 */
export function stabilizeSegmentOctaves(input: readonly MelodySegment[]): MelodySegment[] {
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
    for (let index = anchor - 1; index >= groupStart; index -= 1) {
      const reference = segments[index + 1] as MelodySegment;
      const segment = segments[index] as MelodySegment;
      segment.midiPitch = octaveCandidate(segment.midiPitch, reference.midiPitch);
    }
    for (let index = anchor + 1; index < groupEnd; index += 1) {
      const reference = segments[index - 1] as MelodySegment;
      const segment = segments[index] as MelodySegment;
      segment.midiPitch = octaveCandidate(segment.midiPitch, reference.midiPitch);
    }
    groupStart = groupEnd;
  }
  return segments;
}

function octaveCandidate(pitch: number, reference: number): number {
  // Allow a small intonation margin around the tritone-to-fifth boundary;
  // sung notes and YIN estimates rarely land on exact semitone centres.
  const continuityLimit = 7.5;
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
  return Math.abs(pitch - reference) > continuityLimit &&
    Math.abs(best - reference) <= continuityLimit
    ? best
    : pitch;
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
    midiPitch: weightedMedianPitch(pitched),
    confidence: clamp01(confidenceWeight / pitched.length),
    intensity: Math.max(...pitched.map((frame) => frame.rms)),
  };
}

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
    if (!previous && !next) {
      segments.splice(index, 1);
      index -= 1;
      continue;
    }
    const previousDistance = previous
      ? Math.abs(previous.midiPitch - segment.midiPitch)
      : Number.POSITIVE_INFINITY;
    const nextDistance = next
      ? Math.abs(next.midiPitch - segment.midiPitch)
      : Number.POSITIVE_INFINITY;
    if (previous && previousDistance <= nextDistance) {
      previous.endSec = Math.max(previous.endSec, segment.endSec);
      previous.confidence = Math.max(previous.confidence, segment.confidence);
      previous.intensity = Math.max(previous.intensity, segment.intensity);
    } else if (next) {
      next.startSec = Math.min(next.startSec, segment.startSec);
    }
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
