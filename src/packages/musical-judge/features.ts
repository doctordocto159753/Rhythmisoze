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
  isMeasuredOrigin,
  smoothPitchContour,
  trackFundamentalPitch,
  type PitchFrame,
} from '@/packages/melody-extraction';

/**
 * Strips accepted-pitch authority from inferred frames.
 *
 * A bridged frame keeps its time, its measured energy, and its measured
 * candidate — all real observations — but its interpolated `midiPitch` is
 * withdrawn before the Judge sees it. Every correctness question the Judge
 * answers (is this note supported, where does it really end, what did the
 * human actually sing) must be answerable from measurement alone; the
 * candidate path in `voicedEndAfter` and the null reference in the pitch
 * readers handle the rest honestly.
 */
function withoutInferredAuthority(frames: readonly PitchFrame[]): PitchFrame[] {
  return frames.map((frame) =>
    frame.midiPitch !== null && !isMeasuredOrigin(frame)
      ? { ...frame, midiPitch: null, frequencyHz: null }
      : frame,
  );
}

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
 * The clarity a discarded frame needs before it counts as *provisional* evidence.
 *
 * ## Why this replaced a confidence floor
 *
 * The Judge used to re-filter the contour at `confidence >= 0.5` on top of the
 * tracker's own decision. When the tracker's decision was a single hard
 * threshold that was a reasonable second opinion — the engine had to decide
 * *something* for a marginal frame and the Judge did not.
 *
 * It is no longer a second opinion, it is the same opinion applied twice. The
 * tracker now accepts a frame only when it agrees with the pitch already
 * sounding, so an accepted frame is corroborated by its neighbours rather than
 * by its own score. Re-filtering that on a composite of clarity *and loudness*
 * threw away precisely the frames the redesign recovered: the quiet tail of a
 * sustained note, where the pitch is stable and the level is not. The Judge
 * would then see a note ending where the sound got quiet and shorten the MIDI
 * to match — the original bug, reintroduced one stage later.
 *
 * So the accepted contour is taken as read, and this floor now guards the other
 * direction: which *rejected* frames still carry enough periodicity to be worth
 * consulting when asking whether a note should reach through an uncertain
 * patch. Clarity rather than confidence, because loudness is not evidence about
 * pitch.
 */
export const JUDGE_EVIDENCE_CLARITY = 0.35;

/**
 * Retained under its old name because it described a real threshold that other
 * deployments may have pinned.
 *
 * @deprecated The Judge no longer re-thresholds the accepted contour. Read
 * `JUDGE_EVIDENCE_CLARITY` instead.
 */
export const JUDGE_CONFIDENCE_FLOOR = 0.5;

export function extractJudgeFeatures(audio: MonoAudio): JudgeFeatures {
  const tracked = trackFundamentalPitch(audio.samples, audio.sampleRate);
  const contour = smoothPitchContour(tracked);
  const frames = withoutInferredAuthority(contour.frames);

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
    voicedFrames: frames.filter((frame) => frame.midiPitch !== null).length,
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
  const safeFrames = withoutInferredAuthority(frames);
  const hopSec =
    safeFrames.length >= 2
      ? (safeFrames[1] as PitchFrame).timeSec - (safeFrames[0] as PitchFrame).timeSec
      : 0.01;

  return {
    frames: safeFrames,
    hopSec: hopSec > 0 ? hopSec : 0.01,
    onsets: [...onsets].sort((a, b) => a - b),
    durationSec,
    voicedFrames: safeFrames.filter((frame) => frame.midiPitch !== null).length,
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
  return frame?.midiPitch ?? null;
}

/**
 * What the audio suggests at a moment the app declined to call voiced.
 *
 * `null` where there is genuinely nothing — no candidate, or one too unclear to
 * mean anything. This is how the Judge inspects an uncertain region without
 * inventing anything: the answer is a measurement that was taken and not
 * accepted, never a guess made to fill a hole.
 */
export function provisionalPitchAt(features: JudgeFeatures, timeSec: number): number | null {
  const index = Math.round((timeSec - (features.frames[0]?.timeSec ?? 0)) / features.hopSec);
  const frame = features.frames[Math.max(0, Math.min(features.frames.length - 1, index))];
  if (!frame || frame.candidateMidi === null) return null;
  if (frame.midiPitch !== null) return frame.midiPitch;
  return frame.clarity >= JUDGE_EVIDENCE_CLARITY ? frame.candidateMidi : null;
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
    out.push(frame.midiPitch);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Every pitch the audio offers across a span, accepted or merely measured.
 *
 * Used where the question is "was there anything here?" rather than "what did
 * we decide was here" — chiefly deciding whether a note may reach through a
 * patch the tracker declined. Sorted, like its accepted counterpart, because
 * every caller wants a median.
 */
export function provisionalPitchesDuring(
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
    if (!frame) continue;
    if (frame.midiPitch !== null) {
      out.push(frame.midiPitch);
      continue;
    }
    if (frame.candidateMidi !== null && frame.clarity >= JUDGE_EVIDENCE_CLARITY) {
      out.push(frame.candidateMidi);
    }
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
 * How long an uncertain patch may be before it ends the note anyway.
 *
 * Two frames — twenty milliseconds — used to end it, which is shorter than a
 * single glottal irregularity. A tenth of a second is the shortest gap a
 * listener reliably hears as a break between two notes at the same pitch.
 */
const EVIDENCE_HOLD_SEC = 0.1;

/**
 * Where the sound that produced a note actually ends.
 *
 * Used by duration repair: a note may not sensibly outlast its own sound, and
 * equally should not be cut short of it.
 *
 * ## Why this consults the rejected frames too
 *
 * "Two consecutive unvoiced frames means the note stopped" is only true if
 * "unvoiced" means silence. It does not: it means the tracker declined to
 * accept the frame, which happens routinely in the quiet tail of a held note
 * where the pitch is perfectly stable. Ending there is how a note the singer
 * held for nine hundred milliseconds became a two-hundred-millisecond note.
 *
 * So a patch the tracker rejected extends the note only while the audio still
 * says the same pitch is there — a measured candidate, close to the note, clear
 * enough to mean something. Where there is no such evidence the note ends, and
 * `pitchHint` is what stops this from walking into the *next* note: evidence
 * for a different pitch is not evidence for this one.
 */
export function voicedEndAfter(
  features: JudgeFeatures,
  startSec: number,
  pitchHint: number | null = null,
): number | null {
  const first = features.frames[0]?.timeSec ?? 0;
  let index = Math.max(0, Math.round((startSec - first) / features.hopSec));
  let lastSupported: number | null = null;

  for (; index < features.frames.length; index += 1) {
    const frame = features.frames[index] as PitchFrame;
    const agrees = (pitch: number): boolean =>
      pitchHint === null || Math.abs(pitch - pitchHint) <= 1.5;

    if (frame.midiPitch !== null && agrees(frame.midiPitch)) {
      lastSupported = frame.timeSec;
      continue;
    }
    // Not accepted, but the audio may still say the note is sounding.
    if (
      frame.midiPitch === null &&
      frame.candidateMidi !== null &&
      frame.clarity >= JUDGE_EVIDENCE_CLARITY &&
      agrees(frame.candidateMidi)
    ) {
      lastSupported = frame.timeSec;
      continue;
    }
    if (lastSupported !== null && frame.timeSec - lastSupported > EVIDENCE_HOLD_SEC) break;
  }
  return lastSupported;
}
