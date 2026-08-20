import { midiToFrequency, type PitchFrame } from './pitch-tracker';

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
    .filter((frame) => frame.midiPitch !== null && frame.confidence >= 0.68)
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
export function smoothPitchContour(input: readonly PitchFrame[]): SmoothedContour {
  if (input.length === 0) return { frames: [], range: null };
  const octaveRepaired = input.map((frame, index) => {
    if (frame.midiPitch === null) return { ...frame };
    const local = weightedMedian(
      input
        .slice(Math.max(0, index - 10), Math.min(input.length, index + 11))
        .filter((neighbor) => neighbor.midiPitch !== null)
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
    return withMidi(frame, useCorrected ? corrected : frame.midiPitch);
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
    return { ...frame, frequencyHz: null, midiPitch: null, confidence: frame.confidence * 0.5 };
  });

  const smoothed = ranged.map((frame, index) => {
    if (frame.midiPitch === null) return { ...frame };
    const neighbors = ranged
      .slice(Math.max(0, index - 2), Math.min(ranged.length, index + 3))
      .filter((neighbor) => neighbor.midiPitch !== null)
      .map((neighbor) => ({
        value: neighbor.midiPitch as number,
        weight: Math.max(0.01, neighbor.confidence),
      }));
    if (neighbors.length < 2) return { ...frame };
    return withMidi(frame, weightedMedian(neighbors));
  });

  bridgeShortGaps(smoothed, 3);
  removeShortGlitches(smoothed, 3);
  repairSequentialOctaves(smoothed, preliminaryRange);
  return { frames: smoothed, range: detectAdaptiveVocalRange(smoothed) };
}

function bridgeShortGaps(frames: PitchFrame[], maxGapFrames: number): void {
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
      end - start <= maxGapFrames &&
      before?.midiPitch !== null &&
      before?.midiPitch !== undefined &&
      after?.midiPitch !== null &&
      after?.midiPitch !== undefined &&
      Math.abs(before.midiPitch - after.midiPitch) <= 2
    ) {
      for (let cursor = start; cursor < end; cursor += 1) {
        const amount = (cursor - start + 1) / (end - start + 1);
        const midi = before.midiPitch + (after.midiPitch - before.midiPitch) * amount;
        const original = frames[cursor] as PitchFrame;
        frames[cursor] = withMidi(
          { ...original, confidence: Math.min(before.confidence, after.confidence) * 0.75 },
          midi,
        );
      }
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

function repairSequentialOctaves(frames: PitchFrame[], range: VocalRange | null): void {
  let previous: number | null = null;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] as PitchFrame;
    if (frame.midiPitch === null) continue;
    if (previous !== null && Math.abs(frame.midiPitch - previous) > 6) {
      const folded = closestOctave(frame.midiPitch, previous);
      const octaveLike = Math.abs(Math.abs(frame.midiPitch - previous) - 12) <= 3;
      const insideRange =
        range === null || (folded >= range.lowMidi && folded <= range.highMidi);
      if (octaveLike && insideRange && Math.abs(folded - previous) <= 6) {
        frames[index] = withMidi(frame, folded);
      }
    }
    previous = (frames[index] as PitchFrame).midiPitch;
  }
}

function closestOctave(pitch: number, target: number): number {
  let best = pitch;
  for (let shift = -3; shift <= 3; shift += 1) {
    const candidate = pitch + shift * 12;
    if (Math.abs(candidate - target) < Math.abs(best - target)) best = candidate;
  }
  return best;
}

function withMidi(frame: PitchFrame, midiPitch: number): PitchFrame {
  return {
    ...frame,
    midiPitch,
    frequencyHz: midiToFrequency(midiPitch),
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
