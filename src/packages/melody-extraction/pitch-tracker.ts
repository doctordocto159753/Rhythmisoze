/**
 * Monophonic fundamental-frequency tracking for human voice.
 *
 * ## Why a frame keeps its estimate even when it is not voiced
 *
 * The first version answered one question per frame — *is this a note?* — and
 * threw away the answer to a different one: *what pitch did YIN find here?* A
 * frame that failed the gate had `frequencyHz` and `midiPitch` set to `null`,
 * and the estimate was gone before smoothing, segmentation or the Judge could
 * look at it.
 *
 * That is what made a real 31.2 s hum come out as 7 s of accepted contour.
 * The confidence score was `clarity * (0.55 + 0.45 * energy)`, so a sung note
 * *decaying naturally* lost confidence even though YIN's periodicity reading
 * never moved. From the real take, one sustained note:
 *
 * ```
 *  t      f0     conf    rms
 *  5.31  63.16   0.79   0.0711   kept
 *  5.34  62.92   0.66   0.0566   discarded
 *  5.40  63.06   0.47   0.0397   discarded
 *  5.55  63.18   0.71   0.0532   kept
 *  5.64  63.19   0.63   0.0428   discarded   <- note ended here
 *  5.79  63.09   0.48   0.0149   discarded
 * ```
 *
 * The pitch is stable to within a sixth of a semitone across the whole span.
 * Only the loudness changed. The gate read that as the note ending, cut it at
 * 5.62, and — because only the loud attack frames survived — took its pitch
 * from the part of the note that had not settled yet, emitting 64 for a
 * contour sitting at 63.1.
 *
 * So this module now separates three things that were previously one number:
 *
 *  - **the candidate** — what YIN found, kept unconditionally;
 *  - **clarity** — YIN's own periodicity measure, which does not depend on
 *    loudness and is therefore the real evidence that a pitch is present;
 *  - **energy** — how loud the frame is, which decides whether anything is
 *    happening at all but says nothing about *what*.
 *
 * `confidence` remains the composite of the three, unchanged in meaning, for
 * the quality scorer and the Judge that already read it.
 *
 * ## Why voicing is hysteretic
 *
 * Starting a note and continuing one are different claims and need different
 * evidence. Starting says "a pitch began here", which is a strong claim about a
 * moment. Continuing says "the pitch that was already sounding is still
 * sounding", which the surrounding frames already support. Requiring the same
 * evidence for both is what turns one sustained note into four fragments.
 */

export interface PitchFrame {
  timeSec: number;
  /**
   * The accepted fundamental, or `null` where the frame is not voiced.
   *
   * "Accepted" means the voicing decision below let it through. Downstream code
   * that wants the melody reads this; code that wants to know what was heard in
   * an uncertain region reads `candidateHz` / `candidateMidi`.
   */
  frequencyHz: number | null;
  midiPitch: number | null;
  /**
   * The fundamental YIN estimated, whatever the voicing decision was.
   *
   * `null` only when YIN produced nothing usable at all — no periodicity within
   * the vocal range. A frame may be unvoiced with a perfectly good candidate,
   * and that combination is the evidence gap bridging and the Judge need.
   */
  candidateHz: number | null;
  candidateMidi: number | null;
  /**
   * YIN's periodicity reading, 0..1. Independent of loudness.
   *
   * This is the actual evidence that *a* pitch is present. Voicing keys on it;
   * `confidence` folds energy in on top for consumers that want one number.
   */
  clarity: number;
  /** Composite of clarity and energy, 0..1. Unchanged in meaning. */
  confidence: number;
  /** Frame energy after preprocessing, used for velocity and quality scoring. */
  rms: number;
  /** Whether this frame was accepted as part of a sung region. */
  voiced: boolean;
  /**
   * Where this frame's `midiPitch` value came from.
   *
   * - `measured` — an accepted YIN candidate. Full authority: it votes on
   *   segment pitch, scores confidence, anchors octave repair, and counts as
   *   evidence of musical correctness.
   * - `corrected` — a measured frame whose value a contour stage transformed
   *   (octave repair, smoothing, glitch removal). Still measurement-derived:
   *   same authority as measured.
   * - `interpolated` — a value derived from endpoint measurements across a
   *   filled gap (or held from one endpoint). It preserves temporal continuity
   *   and duration, and nothing else: it does not vote, does not score, does
   *   not anchor repair, and is not evidence of musical correctness.
   * - `predicted` — reserved for synthesis that is neither measurement nor
   *   endpoint interpolation; same restrictions as interpolated.
   *
   * Absent means `measured` — the historical default, kept so fixtures and any
   * external producer of frames keep their meaning.
   */
  origin?: FrameOrigin;
}

/** Provenance of a PitchFrame's accepted pitch value. See {@link PitchFrame.origin}. */
export type FrameOrigin = 'measured' | 'corrected' | 'interpolated' | 'predicted';

/**
 * Frames whose values carry the authority of measurement.
 *
 * This is the single definition of "counts as evidence" for every consumer
 * that decides something about pitch: segment voting, confidence scoring,
 * octave-repair anchoring, register detection and the Judge's reference
 * series all filter through it. Inferred frames (`interpolated`/`predicted`)
 * may extend duration and continuity; they may never decide anything.
 */
export function isMeasuredOrigin(frame: {
  origin?: FrameOrigin;
}): boolean {
  return frame.origin === undefined || frame.origin === 'measured' || frame.origin === 'corrected';
}

export interface PitchTrackerOptions {
  targetSampleRate: number;
  frameSize: number;
  hopSize: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
  yinThreshold: number;
  /**
   * Clarity needed to *begin* a voiced region.
   *
   * A real claim about a moment, so it is held to a real standard. Calibrated
   * against the recordings in `tests/fixtures/audio`: below about 0.45 the
   * tracker starts opening regions inside breath noise.
   */
  onsetClarity: number;
  /**
   * Clarity needed to *continue* one that is already open.
   *
   * Deliberately far lower. Continuation is corroborated by the frames on
   * either side and by `continuitySemitones` below — a frame only continues a
   * note if it agrees with the pitch already sounding, which noise cannot do
   * for more than a frame or two by accident.
   */
  sustainClarity: number;
  /**
   * How far a frame's candidate may sit from the pitch already sounding and
   * still count as the same note continuing.
   *
   * Wide enough for vibrato and a portamento in progress, narrow enough that a
   * subharmonic (a whole octave away) cannot masquerade as continuation.
   */
  continuitySemitones: number;
  /** Energy, as a multiple of the adaptive floor, needed to begin a region. */
  onsetEnergyRatio: number;
  /** Energy, as a multiple of the adaptive floor, needed to continue one. */
  sustainEnergyRatio: number;
  /**
   * How far back a confirmed onset may reach to recover its own attack.
   *
   * A hummed phrase often starts breathy: the first few frames carry the right
   * pitch at poor clarity, and the note as heard begins before the tracker is
   * sure. Once a region is open the frames behind it can be re-read with the
   * continuation standard, which is what recovers a weak attack without
   * lowering the standard for opening one.
   */
  attackLookbackFrames: number;
  /**
   * Shortest run of frames that may be called a voiced region.
   *
   * One strong frame surrounded by noise is a transient — a click, a plosive,
   * a chair — not a pitch. Without this a single lucky frame opens a region
   * that segmentation then has to argue with; on the real take one such frame
   * at 3.36 s ended up anchoring a two-and-a-half second note over silence.
   */
  minVoicedRunFrames: number;
  /**
   * How many agreeing frames of natural decay a held region may ride below the
   * sustain-energy ratio before the region is allowed to end.
   *
   * A hummed note does not stop when its loudness crosses a threshold; it fades
   * while the pitch stays put. Ending the region at the threshold cut every
   * tail early — audibly so on phrase-final notes. The hold is bounded, and it
   * still requires the evidence that matters (clarity plus an agreeing
   * candidate above the grace floor), so a true rest — where no candidate
   * exists, or the level has sunk into the take's floor — ends the note exactly
   * where it did before.
   */
  tailHoldFrames: number;
}

export const DEFAULT_PITCH_TRACKER_OPTIONS: PitchTrackerOptions = {
  targetSampleRate: 16_000,
  frameSize: 1024,
  hopSize: 160,
  minFrequencyHz: 70,
  maxFrequencyHz: 1000,
  yinThreshold: 0.16,
  onsetClarity: 0.62,
  sustainClarity: 0.34,
  continuitySemitones: 1.6,
  onsetEnergyRatio: 1.35,
  sustainEnergyRatio: 0.62,
  attackLookbackFrames: 8,
  minVoicedRunFrames: 3,
  tailHoldFrames: 22,
};

/**
 * How far below the sustain ratio the two bounded graces may still reach.
 *
 * The sustain ratio is 0.62 of the gate, so a grace that reached only to the
 * gate would govern an empty band and never fire. This sits far enough under
 * both to describe a real decay — while staying clear of the silence floor,
 * which on takes with room tone is what set the gate in the first place.
 */
const GRACE_ENERGY_FACTOR = 0.45;

export interface PreparedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Makes recordings from microphones/codecs comparable without changing pitch:
 * mono input is resampled, DC is removed, and peak gain is bounded.
 */
export function prepareVoiceAudio(
  samples: Float32Array,
  sampleRate: number,
  targetSampleRate = DEFAULT_PITCH_TRACKER_OPTIONS.targetSampleRate,
): PreparedAudio {
  const resampled = sampleRate === targetSampleRate
    ? new Float32Array(samples)
    : linearResample(samples, sampleRate, targetSampleRate);
  const filtered = new Float32Array(resampled.length);
  let previousInput = 0;
  let previousOutput = 0;
  let peak = 0;
  for (let index = 0; index < resampled.length; index += 1) {
    const input = resampled[index] ?? 0;
    // One-pole DC blocker. Its corner is low enough to leave vocal fundamentals intact.
    const output = input - previousInput + 0.995 * previousOutput;
    filtered[index] = output;
    previousInput = input;
    previousOutput = output;
    peak = Math.max(peak, Math.abs(output));
  }
  // Two gains of headroom, not eight: on a take recorded at whisper level the
  // 8x cap left the signal close enough to the 16-bit floor that quantization
  // noise, not the voice, set the adaptive gate, and notes fragmented. The cap
  // only ever engages below a -25 dBFS peak, where every extra multiple of two
  // is pure signal.
  const gain = peak > 1e-5 ? Math.min(16, 0.92 / peak) : 1;
  if (Math.abs(gain - 1) > 1e-6) {
    for (let index = 0; index < filtered.length; index += 1) {
      filtered[index] = (filtered[index] ?? 0) * gain;
    }
  }
  return { samples: filtered, sampleRate: targetSampleRate };
}

/** One frame's raw measurements, before any voicing decision is taken. */
export interface FrameEvidence {
  timeSec: number;
  candidateHz: number | null;
  candidateMidi: number | null;
  clarity: number;
  rms: number;
  confidence: number;
}

export interface TrackedAudio {
  frames: PitchFrame[];
  /** The adaptive energy floor this take was measured against. */
  energyGate: number;
}

/**
 * Runs YIN and decides voicing with hysteresis, keeping every estimate.
 *
 * Returns frames rather than a richer object so the common call site stays a
 * one-liner; `trackVoiceEvidence` exposes the gate for anything that needs to
 * reason about the energy floor itself.
 */
export function trackFundamentalPitch(
  samples: Float32Array,
  sampleRate: number,
  overrides: Partial<PitchTrackerOptions> = {},
): PitchFrame[] {
  return trackVoiceEvidence(samples, sampleRate, overrides).frames;
}

export function trackVoiceEvidence(
  samples: Float32Array,
  sampleRate: number,
  overrides: Partial<PitchTrackerOptions> = {},
): TrackedAudio {
  const options = { ...DEFAULT_PITCH_TRACKER_OPTIONS, ...overrides };
  const prepared = prepareVoiceAudio(samples, sampleRate, options.targetSampleRate);
  const measured: Array<{
    timeSec: number;
    frequencyHz: number;
    clarity: number;
    rms: number;
  }> = [];

  for (
    let start = 0;
    start + options.frameSize <= prepared.samples.length;
    start += options.hopSize
  ) {
    const frame = prepared.samples.subarray(start, start + options.frameSize);
    const rms = rootMeanSquare(frame);
    const estimate = yin(frame, prepared.sampleRate, options);
    measured.push({
      timeSec: start / prepared.sampleRate,
      frequencyHz: estimate.frequencyHz,
      clarity: estimate.clarity,
      rms,
    });
  }

  const energies = measured.map((frame) => frame.rms).sort((a, b) => a - b);
  const noiseFloor = percentile(energies, 0.2);
  const strongLevel = percentile(energies, 0.9);
  const energyGate = Math.max(0.003, Math.min(strongLevel * 0.18, noiseFloor * 2.8 + 0.0015));
  const usefulSpan = Math.max(0.004, strongLevel - energyGate);

  const evidence: FrameEvidence[] = measured.map((frame) => {
    const inRange =
      frame.frequencyHz >= options.minFrequencyHz && frame.frequencyHz <= options.maxFrequencyHz;
    const energyConfidence = clamp01((frame.rms - energyGate) / usefulSpan);
    return {
      timeSec: frame.timeSec,
      candidateHz: inRange ? frame.frequencyHz : null,
      candidateMidi: inRange ? frequencyToMidi(frame.frequencyHz) : null,
      clarity: clamp01(frame.clarity),
      rms: frame.rms,
      // The composite, unchanged, for consumers that want one number.
      confidence: clamp01(frame.clarity * (0.55 + 0.45 * energyConfidence)),
    };
  });

  return { frames: decideVoicing(evidence, energyGate, options), energyGate };
}

/**
 * Turns per-frame evidence into voiced regions.
 *
 * Two standards, and a continuity test that ties them together:
 *
 * ```
 * open  a region  clarity >= onsetClarity   and energy >= gate * onsetEnergyRatio
 * hold  a region  clarity >= sustainClarity and energy >= gate * sustainEnergyRatio
 *                 and the candidate is within continuitySemitones of the pitch
 *                 already sounding
 * ```
 *
 * One bounded grace extends the hold without weakening what starts a note:
 *
 * - a decaying tail (clarity held, agreeing candidate, level still above the
 *   grace floor) rides below the sustain ratio for up to `tailHoldFrames`, so
 *   notes no longer stop where their loudness crossed a threshold.
 *
 * The continuity test is what makes the low sustain threshold safe. A weak
 * frame is only accepted if it *agrees with what is already there*, so noise —
 * which by definition does not — cannot ride a region open. That is the
 * difference between this and lowering one global threshold, which admits noise
 * everywhere with no such requirement.
 *
 * Exported for testing: the voicing rule is the heart of the fix and deserves
 * to be checkable without synthesising audio.
 */
export function decideVoicing(
  evidence: readonly FrameEvidence[],
  energyGate: number,
  overrides: Partial<PitchTrackerOptions> = {},
): PitchFrame[] {
  const options = { ...DEFAULT_PITCH_TRACKER_OPTIONS, ...overrides };
  const onsetEnergy = energyGate * options.onsetEnergyRatio;
  const sustainEnergy = energyGate * options.sustainEnergyRatio;

  const voiced = new Array<boolean>(evidence.length).fill(false);
  // The pitch currently sounding, as a slow follower rather than the last
  // frame: a single bad frame inside a note must not drag the reference with it
  // and let the note wander an octave.
  let sounding: number | null = null;
  // How long the current region has been riding on decay grace.
  let tailHold = 0;

  for (let index = 0; index < evidence.length; index += 1) {
    const frame = evidence[index] as FrameEvidence;
    if (frame.candidateMidi === null) {
      sounding = null;
      tailHold = 0;
      continue;
    }

    if (sounding === null) {
      if (frame.clarity >= options.onsetClarity && frame.rms >= onsetEnergy) {
        voiced[index] = true;
        sounding = frame.candidateMidi;
        tailHold = 0;
        // Reach back for the attack. Continuation evidence, not onset evidence:
        // these frames are corroborated by the confirmed onset ahead of them.
        for (let back = index - 1; back >= Math.max(0, index - options.attackLookbackFrames); back -= 1) {
          const earlier = evidence[back] as FrameEvidence;
          if (
            earlier.candidateMidi === null ||
            earlier.clarity < options.sustainClarity ||
            earlier.rms < sustainEnergy ||
            Math.abs(earlier.candidateMidi - frame.candidateMidi) > options.continuitySemitones
          ) {
            break;
          }
          voiced[back] = true;
        }
      }
      continue;
    }

    const delta = frame.candidateMidi - sounding;
    const agrees = Math.abs(delta) <= options.continuitySemitones;
    // The decay grace reaches below the sustain ratio — that is its purpose —
    // but never below this fraction of the take's own floor. A true rest sinks
    // beneath it immediately; a decaying note crosses it slowly.
    const graceEnergy = energyGate * GRACE_ENERGY_FACTOR;

    if (frame.clarity >= options.sustainClarity && frame.rms >= sustainEnergy && agrees) {
      voiced[index] = true;
      // A gentle follower, so vibrato and portamento move the reference while a
      // one-frame excursion does not.
      sounding += delta * 0.25;
      tailHold = 0;
      continue;
    }

    if (
      frame.clarity >= options.sustainClarity &&
      agrees &&
      frame.rms >= graceEnergy &&
      tailHold < options.tailHoldFrames
    ) {
      // The note is decaying, not finished: pitch still locked, level sinking
      // toward the floor of the take. Hold the region open while the decay
      // stays real. An octave-displaced reading does NOT qualify: a held
      // region spanning subharmonic stretches lets downstream segment-octave
      // repair flip whole phrases into the wrong register — measured, not
      // theorised, on a quiet articulated take whose opening phrase landed an
      // octave flat under exactly this grace.
      voiced[index] = true;
      sounding += delta * 0.25;
      tailHold += 1;
      continue;
    }

    // The region has ended as far as this pass is concerned. A frame that is
    // strong enough on its own immediately opens a new one, which is what a
    // genuine leap to another note looks like.
    if (frame.clarity >= options.onsetClarity && frame.rms >= onsetEnergy) {
      voiced[index] = true;
      sounding = frame.candidateMidi;
      tailHold = 0;
      continue;
    }
    sounding = null;
    tailHold = 0;
  }

  dropIsolatedRuns(voiced, options.minVoicedRunFrames);

  return evidence.map((frame, index) => ({
    timeSec: frame.timeSec,
    frequencyHz: voiced[index] ? frame.candidateHz : null,
    midiPitch: voiced[index] ? frame.candidateMidi : null,
    candidateHz: frame.candidateHz,
    candidateMidi: frame.candidateMidi,
    clarity: frame.clarity,
    confidence: frame.confidence,
    rms: frame.rms,
    voiced: voiced[index] === true,
    origin: 'measured' as const,
  }));
}

/** Erases voiced runs too short to be a note. See `minVoicedRunFrames`. */
function dropIsolatedRuns(voiced: boolean[], minRun: number): void {
  let index = 0;
  while (index < voiced.length) {
    if (!voiced[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < voiced.length && voiced[index]) index += 1;
    if (index - start < minRun) {
      for (let cursor = start; cursor < index; cursor += 1) voiced[cursor] = false;
    }
  }
}

export function frequencyToMidi(frequencyHz: number): number {
  return 69 + 12 * Math.log2(frequencyHz / 440);
}

export function midiToFrequency(midiPitch: number): number {
  return 440 * 2 ** ((midiPitch - 69) / 12);
}

function yin(
  frame: Float32Array,
  sampleRate: number,
  options: PitchTrackerOptions,
): { frequencyHz: number; clarity: number } {
  const analysisSize = frame.length >> 1;
  const minTau = Math.max(2, Math.floor(sampleRate / options.maxFrequencyHz));
  const maxTau = Math.min(analysisSize - 1, Math.ceil(sampleRate / options.minFrequencyHz));
  if (maxTau <= minTau) return { frequencyHz: 0, clarity: 0 };

  const difference = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau += 1) {
    let sum = 0;
    for (let index = 0; index < analysisSize; index += 1) {
      const delta = (frame[index] ?? 0) - (frame[index + tau] ?? 0);
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  const normalized = new Float32Array(maxTau + 1);
  normalized[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    running += difference[tau] ?? 0;
    normalized[tau] = running > 0 ? ((difference[tau] ?? 0) * tau) / running : 1;
  }

  let chosen = -1;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if ((normalized[tau] ?? 1) < options.yinThreshold) {
      chosen = tau;
      while (
        chosen < maxTau &&
        (normalized[chosen + 1] ?? 1) < (normalized[chosen] ?? 1)
      ) {
        chosen += 1;
      }
      break;
    }
  }
  if (chosen < 0) {
    chosen = minTau;
    for (let tau = minTau + 1; tau <= maxTau; tau += 1) {
      if ((normalized[tau] ?? 1) < (normalized[chosen] ?? 1)) chosen = tau;
    }
  }

  let refinedTau = chosen;
  if (chosen > minTau && chosen < maxTau) {
    const left = normalized[chosen - 1] ?? 1;
    const center = normalized[chosen] ?? 1;
    const right = normalized[chosen + 1] ?? 1;
    const denominator = 2 * (2 * center - left - right);
    if (Math.abs(denominator) > 1e-9) refinedTau += (right - left) / denominator;
  }
  return {
    frequencyHz: refinedTau > 0 ? sampleRate / refinedTau : 0,
    clarity: clamp01(1 - (normalized[chosen] ?? 1)),
  };
}

function linearResample(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (input.length === 0 || inputRate <= 0 || outputRate <= 0) return new Float32Array();
  const length = Math.max(1, Math.round((input.length * outputRate) / inputRate));
  const output = new Float32Array(length);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

function rootMeanSquare(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = clamp01(fraction) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const mix = position - low;
  return (sorted[low] ?? 0) * (1 - mix) + (sorted[high] ?? 0) * mix;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
