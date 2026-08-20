/**
 * The evidence the Judge decides on.
 *
 * The Judge answers exactly one question — *did we understand the human
 * correctly?* — so it needs an account of what the human actually did that is
 * independent of the MIDI it is judging. That account is this file.
 *
 * ## Why this reuses the existing extractors
 *
 * The reference contour comes from the same YIN tracker and smoothing the
 * melody engine already uses, and the onsets from the same spectral-flux
 * detector the rhythm path uses. Using a *different* pitch tracker to judge the
 * first one sounds more rigorous and is actually worse: disagreements between
 * two trackers would be scored as transcription failures, and the Judge would
 * spend its repair budget chasing them.
 *
 * What makes the comparison meaningful is not a second opinion on the pitch.
 * It is that the contour is a per-frame measurement of the audio while the MIDI
 * is a set of discrete note decisions, and the failures we care about — a
 * harmonic held as a note, an octave slip, one note split into three — are all
 * visible as disagreements between those two representations.
 */

import type { MonoAudio } from '@contracts';
import { detectOnsets } from '@audio-core';
import {
  smoothPitchContour,
  trackFundamentalPitch,
  type PitchFrame,
} from '@/packages/melody-extraction';

export interface JudgeFeatures {
  /** Per-frame fundamental, `midiPitch === null` where unvoiced. */
  frames: PitchFrame[];
  /** Seconds between frames. */
  hopSec: number;
  /** Attack times in seconds, from the audio rather than from the MIDI. */
  onsets: number[];
  durationSec: number;
  /** Voiced frame count, so callers can refuse to judge near-silence. */
  voicedFrames: number;
}

/**
 * Frames below this confidence are treated as unvoiced for judging.
 *
 * Higher than the melody engine's own threshold on purpose. The engine has to
 * decide *something* for a marginal frame; the Judge does not, and a weak frame
 * used as evidence is worse than no evidence — it will happily "correct" a good
 * note toward a tracking error.
 */
export const JUDGE_CONFIDENCE_FLOOR = 0.5;

export function extractJudgeFeatures(audio: MonoAudio): JudgeFeatures {
  const tracked = trackFundamentalPitch(audio.samples, audio.sampleRate);
  const contour = smoothPitchContour(tracked);
  const frames = contour.frames;

  const hopSec =
    frames.length >= 2
      ? (frames[1] as PitchFrame).timeSec - (frames[0] as PitchFrame).timeSec
      : 0.01;

  const detection = detectOnsets(audio.samples, audio.sampleRate);

  return {
    frames,
    hopSec: hopSec > 0 ? hopSec : 0.01,
    onsets: detection.onsets.map((onset) => onset.timeSec),
    durationSec: audio.durationSec,
    voicedFrames: frames.filter(
      (frame) => frame.midiPitch !== null && frame.confidence >= JUDGE_CONFIDENCE_FLOOR,
    ).length,
  };
}

/**
 * Builds features from a contour that has already been computed.
 *
 * The melody engine tracks the fundamental as part of its own work, and YIN
 * over a 60 second take is the single most expensive thing in the pipeline.
 * Running it a second time purely to judge the first run would roughly double
 * the wait for no additional information, so the worker passes its frames
 * straight through and only the onset detection is done again.
 */
export function judgeFeaturesFromFrames(
  frames: readonly PitchFrame[],
  durationSec: number,
  onsets: readonly number[],
): JudgeFeatures {
  const hopSec =
    frames.length >= 2
      ? (frames[1] as PitchFrame).timeSec - (frames[0] as PitchFrame).timeSec
      : 0.01;

  return {
    frames: [...frames],
    hopSec: hopSec > 0 ? hopSec : 0.01,
    onsets: [...onsets].sort((a, b) => a - b),
    durationSec,
    voicedFrames: frames.filter(
      (frame) => frame.midiPitch !== null && frame.confidence >= JUDGE_CONFIDENCE_FLOOR,
    ).length,
  };
}

/**
 * The reference pitch at a moment, or `null` where the audio was unvoiced.
 *
 * Nearest-frame rather than interpolated: interpolating across an unvoiced gap
 * invents a pitch the human never sang, which is precisely the kind of
 * fabrication this engine exists to remove.
 */
export function referencePitchAt(features: JudgeFeatures, timeSec: number): number | null {
  const index = Math.round((timeSec - (features.frames[0]?.timeSec ?? 0)) / features.hopSec);
  const frame = features.frames[Math.max(0, Math.min(features.frames.length - 1, index))];
  if (!frame || frame.midiPitch === null) return null;
  return frame.confidence >= JUDGE_CONFIDENCE_FLOOR ? frame.midiPitch : null;
}

/**
 * The reference pitches spanned by a note, as a sorted array.
 * Empty when the note covers no voiced audio at all — which is the signature of
 * a fabricated note.
 */
export function referencePitchesDuring(
  features: JudgeFeatures,
  startSec: number,
  endSec: number,
): number[] {
  const out: number[] = [];
  const first = features.frames[0]?.timeSec ?? 0;
  const from = Math.max(0, Math.floor((startSec - first) / features.hopSec));
  const to = Math.min(features.frames.length - 1, Math.ceil((endSec - first) / features.hopSec));

  for (let i = from; i <= to; i += 1) {
    const frame = features.frames[i];
    if (!frame || frame.midiPitch === null) continue;
    if (frame.confidence < JUDGE_CONFIDENCE_FLOOR) continue;
    out.push(frame.midiPitch);
  }
  return out.sort((a, b) => a - b);
}

/** Median of a sorted array. Used everywhere a note needs one representative pitch. */
export function medianOfSorted(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Where the voiced audio ends after a given time.
 *
 * Used by duration repair: a note may not sensibly outlast the sound that
 * produced it.
 */
export function voicedEndAfter(features: JudgeFeatures, startSec: number): number | null {
  const first = features.frames[0]?.timeSec ?? 0;
  let index = Math.max(0, Math.round((startSec - first) / features.hopSec));
  let lastVoiced: number | null = null;

  for (; index < features.frames.length; index += 1) {
    const frame = features.frames[index] as PitchFrame;
    const voiced = frame.midiPitch !== null && frame.confidence >= JUDGE_CONFIDENCE_FLOOR;
    if (voiced) lastVoiced = frame.timeSec;
    // Two consecutive unvoiced frames after voicing began means the note stopped.
    else if (lastVoiced !== null && frame.timeSec - lastVoiced > features.hopSec * 2) break;
  }
  return lastVoiced;
}
