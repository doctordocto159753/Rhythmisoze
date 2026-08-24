/**
 * What is this recording?
 *
 * Everything uploaded used to go into Melody Mode, which meant a guitar take
 * was handed to a monophonic voice tracker and a beatbox take was asked for its
 * fundamental frequency. Both produce nonsense, and neither is the user's fault.
 *
 * This classifies the audio into the three intents the product actually has,
 * and — the part that matters most — **says when it does not know**. A confident
 * wrong guess costs the user their idea. Insufficient evidence is therefore an
 * explicit result instead of being forced through one of the musical routes.
 *
 * ## What separates the three
 *
 * | | pitch stability | harmonicity | onset density | spectral spread |
 * |---|---|---|---|---|
 * | **voice**      | high, continuous | high | low  | narrow, low centroid |
 * | **instrument** | high, stepped    | high | mid  | wider, more partials |
 * | **beat**       | none             | low  | high | broad, transient |
 *
 * Voice and instrument are the hard pair, because a hummed line and a plucked
 * line share most of their statistics. The discriminator that actually works is
 * **continuity**: a voice glides between notes and its pitch track is unbroken
 * through a phrase, while a plucked or struck instrument restarts its envelope
 * on every note, leaving gaps in the pitch track and a much sharper attack.
 *
 * Everything here is measured, not learned. There is no licensed corpus for
 * this, and a rule set can be read, argued with and corrected by whoever
 * receives a bad classification report.
 */

import type {
  DrumEvent,
  InputClassification,
  InputType,
  MonoAudio,
  NoteEvent,
} from '@contracts';
import {
  bandEnergyRatio,
  magnitudeSpectrum,
  peakNormalize,
  rmsOf,
  spectralCentroid,
  zeroCrossingRate,
} from '@audio-core';

export type Intent = 'voice' | 'instrument' | 'beat';

export interface IntentFeatures {
  /** Fraction of frames carrying a usable fundamental, 0..1. */
  voicedRatio: number;
  /** How steady the pitch is inside voiced runs, 0..1. */
  pitchStability: number;
  /** Mean length of an unbroken voiced run, in seconds. */
  meanVoicedRunSec: number;
  /** Detected attacks per second. */
  onsetRate: number;
  /** Mean spectral centroid in Hz. */
  centroidHz: number;
  /** Energy above 4 kHz as a fraction of the total, 0..1. */
  highRatio: number;
  /** Mean zero-crossing rate, 0..1. */
  zeroCrossingRate: number;
  /** How sharply energy rises at attacks, 0..1. Percussion and plucks are high. */
  attackSharpness: number;
}

export interface IntentClassification {
  intent: Intent;
  /** 0..1. Below `INTENT_ASK_THRESHOLD` the UI must ask instead of assuming. */
  confidence: number;
  /** Score for every intent, so a wrong answer can be explained. */
  scores: Record<Intent, number>;
  features: IntentFeatures;
  /** `true` when the app should ask the user rather than proceed. */
  shouldAsk: boolean;
}

/**
 * Below this the classifier hands the decision to the user.
 *
 * Set high on purpose. Processing a take in the wrong mode wastes the user's
 * time and produces a result that makes the product look broken; asking costs
 * one tap on a screen they are already looking at.
 */
export const INTENT_ASK_THRESHOLD = 0.62;

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;

/**
 * Extracts the features the classification is made from.
 * Exported so a misclassification can be reported with its evidence.
 */
export function extractIntentFeatures(audio: MonoAudio): IntentFeatures {
  // Validation deliberately accepts faint performances, and every inference
  // engine normalizes them before use. Classification must use the same
  // level-invariant evidence or a quiet but valid take becomes `unknown` before
  // it can reach those engines.
  const { samples, sampleRate } = peakNormalize(audio);
  const frameCount = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1);

  if (frameCount < 4) {
    return {
      voicedRatio: 0,
      pitchStability: 0,
      meanVoicedRunSec: 0,
      onsetRate: 0,
      centroidHz: 0,
      highRatio: 0,
      zeroCrossingRate: 0,
      attackSharpness: 0,
    };
  }

  const centroids: number[] = [];
  const highRatios: number[] = [];
  const zcrs: number[] = [];
  const energies: number[] = [];
  const periodicities: number[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    const start = i * HOP_SIZE;
    const frame = samples.slice(start, start + FRAME_SIZE);
    const magnitude = magnitudeSpectrum(frame);

    centroids.push(spectralCentroid(magnitude, sampleRate));
    highRatios.push(bandEnergyRatio(magnitude, sampleRate, 4000, sampleRate / 2));
    zcrs.push(zeroCrossingRate(samples, start, start + FRAME_SIZE));
    energies.push(rmsOf(samples, start, start + FRAME_SIZE));
    periodicities.push(periodicityOf(frame));
  }

  const energyFloor = Math.max(0.004, median(energies) * 0.35);
  const voiced = periodicities.map(
    (periodicity, i) => periodicity > 0.62 && (energies[i] as number) > energyFloor,
  );

  const hopSec = HOP_SIZE / sampleRate;
  const runs = voicedRuns(voiced).map((length) => length * hopSec);
  const voicedCount = voiced.filter(Boolean).length;

  return {
    voicedRatio: voicedCount / frameCount,
    pitchStability: stabilityOf(periodicities, voiced),
    meanVoicedRunSec: runs.length > 0 ? runs.reduce((a, b) => a + b, 0) / runs.length : 0,
    onsetRate: countAttacks(energies) / (frameCount * hopSec),
    centroidHz: mean(centroids),
    highRatio: mean(highRatios),
    zeroCrossingRate: mean(zcrs),
    attackSharpness: sharpnessOf(energies),
  };
}

/**
 * Classifies a recording.
 *
 * Each intent scores every feature it cares about between 0 and 1, and the
 * scores are combined with weights that reflect how discriminating the feature
 * actually is — continuity separates voice from instrument, so it is weighted
 * heavily; centroid barely separates anything, so it is weighted lightly.
 */
export function classifyIntent(audio: MonoAudio): IntentClassification {
  const features = extractIntentFeatures(audio);

  // Percussion is defined by attacks, so the beat score is gated on there being
  // some. Without this gate, anything unpitched scores as a beat - tape hiss, a
  // fan, a held breath - purely for lacking a fundamental, and the classifier
  // reports high confidence about a recording containing no music at all.
  const percussive = ramp(features.onsetRate, 0.5, 2);
  const beat =
    percussive *
    (0.4 * inverse(features.voicedRatio) +
      0.2 * ramp(features.onsetRate, 1.2, 4) +
      0.2 * features.attackSharpness +
      0.1 * ramp(features.zeroCrossingRate, 0.12, 0.4) +
      0.1 * ramp(features.highRatio, 0.15, 0.5));

  // Voice and instrument are both *pitched* intents, so both are gated on the
  // recording having a fundamental at all. Without this gate a beatbox take
  // scores as an instrument: its attacks are sharp and its voiced runs are
  // short, which are two of the things a plucked string also does. Percussion
  // is not a quiet guitar, and the difference is that it has no pitch.
  const pitched = ramp(features.voicedRatio, 0.15, 0.55);
  const voiceContinuity = Math.max(
    ramp(features.meanVoicedRunSec, 0.12, 0.5),
    syllabicVoiceEvidence(features),
  );

  // A voice glides: long unbroken voiced runs, stable pitch, soft attacks.
  const voice =
    pitched *
    (0.4 * voiceContinuity +
      0.25 * features.pitchStability +
      0.2 * inverse(features.attackSharpness) +
      0.15 * inverse(ramp(features.centroidHz, 900, 3500)));

  // A plucked or struck instrument is pitched but restarts every note: shorter
  // voiced runs, sharper attacks, brighter spectrum.
  const instrument =
    pitched *
    (0.34 * features.attackSharpness +
      0.28 * inverse(ramp(features.meanVoicedRunSec, 0.1, 0.45)) +
      0.2 * ramp(features.centroidHz, 700, 3000) +
      0.18 * features.pitchStability);

  const raw: Record<Intent, number> = { voice, instrument, beat };
  const total = voice + instrument + beat || 1;
  const scores: Record<Intent, number> = {
    voice: raw.voice / total,
    instrument: raw.instrument / total,
    beat: raw.beat / total,
  };

  const ranked = (Object.keys(scores) as Intent[]).sort((a, b) => scores[b] - scores[a]);
  const winner = ranked[0] as Intent;
  const runnerUp = ranked[1] as Intent;

  // Confidence needs both halves. The margin over the runner-up says whether one
  // intent stands out; the winner's *raw* score says whether anything matched at
  // all. A recording that fits none of the three produces three scores near zero
  // and a large relative margin between them, which without the second term
  // would read as certainty about noise.
  const margin = (scores[winner] - scores[runnerUp]) / Math.max(scores[winner], 1e-6);
  const evidence = ramp(raw[winner], 0.12, 0.4);
  const confidence = clamp01((0.42 + margin * 1.4) * evidence);

  return {
    intent: winner,
    confidence,
    scores,
    features,
    shouldAsk: confidence < INTENT_ASK_THRESHOLD,
  };
}

export interface MidiClassificationInput {
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  durationSec: number;
  trackCount: number;
}

/**
 * Product-facing classifier. It never asks the user to label their own sound;
 * uncertainty remains observable in `confidence` and `reasoning` instead.
 */
export class InputClassifier {
  classify(audio: MonoAudio): InputClassification {
    const legacy = classifyIntent(audio);
    const pitched = legacy.scores.voice + legacy.scores.instrument;
    const pitchedEvidence = ramp(legacy.features.voicedRatio, 0.15, 0.55);
    const voiceContinuity = Math.max(
      inverse(legacy.features.attackSharpness) *
        ramp(legacy.features.meanVoicedRunSec, 0.1, 0.45),
      syllabicVoiceEvidence(legacy.features),
    );
    const instrumentAttacks =
      ramp(legacy.features.attackSharpness, 0.18, 0.55) *
      inverse(ramp(legacy.features.meanVoicedRunSec, 0.18, 0.55));
    const onsetMixedEvidence =
      ramp(legacy.features.voicedRatio, 0.18, 0.55) *
      ramp(legacy.features.onsetRate, 0.8, 3.5) *
      Math.min(pitched, legacy.scores.beat) *
      2.4;
    // A sustained pitched bed can raise the adaptive energy floor enough that
    // attacks embedded in it no longer count as standalone onsets. Spectral
    // brightness plus sharp rises inside a long voiced run retains that mixed
    // evidence without mistaking a sequence of short plucks for voice+rhythm.
    const embeddedTransientEvidence =
      pitchedEvidence *
      voiceContinuity *
      ramp(legacy.features.attackSharpness, 0.12, 0.34) *
      ramp(legacy.features.centroidHz, 1400, 4000) *
      3.2;
    const mixedEvidence = Math.max(onsetMixedEvidence, embeddedTransientEvidence);

    const raw = {
      melody: legacy.scores.voice * (0.55 + voiceContinuity) * pitchedEvidence,
      polyphonic:
        (legacy.scores.instrument * (0.55 + instrumentAttacks) +
          pitched * instrumentAttacks * 0.35) *
        pitchedEvidence,
      rhythm: legacy.scores.beat,
      mixed: mixedEvidence,
    };
    const total = Object.values(raw).reduce((sum, value) => sum + value, 0) || 1;
    const scores: Record<InputType, number> = {
      melody: raw.melody / total,
      polyphonic: raw.polyphonic / total,
      rhythm: raw.rhythm / total,
      mixed: raw.mixed / total,
      unknown: 0,
    };
    const ranked: Array<Exclude<InputType, 'unknown'>> = [
      'melody',
      'polyphonic',
      'rhythm',
      'mixed',
    ];
    ranked.sort((a, b) => scores[b] - scores[a]);
    const recommendation = ranked[0] as Exclude<InputType, 'unknown'>;
    const runnerUp = ranked[1] as Exclude<InputType, 'unknown'>;
    const margin = scores[recommendation] - scores[runnerUp];
    const confidence = clamp01(legacy.confidence * 0.7 + margin * 0.6);
    // `shouldAsk` in the original three-way classifier also means "voice and
    // instrument are close". That is route uncertainty, not absence of music:
    // a clearly periodic plucked phrase must still reach the multipitch engine.
    // Abstain only when the confidence is low *and* there is no usable pitched
    // evidence. Transient rhythm already wins its legacy classification with
    // enough confidence; steady noise has neither kind of evidence.
    const hasUsablePitch = pitchedEvidence >= 0.25 && legacy.features.pitchStability >= 0.35;
    const type: InputType = legacy.shouldAsk && !hasUsablePitch ? 'unknown' : recommendation;
    if (type === 'unknown') {
      const unknownScore = Math.max(0.5, 1 - confidence);
      const routedScale = 1 - unknownScore;
      for (const route of ['melody', 'polyphonic', 'rhythm', 'mixed'] as const) {
        scores[route] *= routedScale;
      }
      scores.unknown = unknownScore;
    }

    return {
      type,
      confidence,
      reasoning: audioReasoning(type, legacy.features, scores),
      scores,
      features: { ...legacy.features },
      method: 'automatic',
    };
  }

  classifyMidi(input: MidiClassificationInput): InputClassification {
    const { notes, drums } = input;
    const durations = notes.map((note) => Math.max(0, note.endSec - note.startSec));
    const shortNotes = durations.filter((duration) => duration <= 0.16).length;
    const shortRatio = notes.length > 0 ? shortNotes / notes.length : 0;
    const onsetGroups = groupNotesByOnset(notes);
    const onsetCount = onsetGroups.length;
    const pitchCounts = countBy(notes.map((note) => note.pitch));
    const pitchCount = pitchCounts.size;
    const orderedPitchCounts = [...pitchCounts.values()].sort((a, b) => b - a);
    const dominantLayerRatio = notes.length > 0
      ? orderedPitchCounts.slice(0, 3).reduce((sum, count) => sum + count, 0) / notes.length
      : 0;
    const repeatedLayerRatio = notes.length > 0
      ? notes.filter((note) => (pitchCounts.get(note.pitch) ?? 0) >= 4).length / notes.length
      : 0;
    const simultaneousOnsetRatio = onsetCount > 0
      ? onsetGroups.filter((group) => group.length > 1).length / onsetCount
      : 0;
    const chordalOnsetRatio = onsetCount > 0
      ? onsetGroups.filter(isChordLikeGroup).length / onsetCount
      : 0;
    const maxOnsetGroup = Math.max(0, ...onsetGroups.map((group) => group.length));
    const maxPolyphony = maximumPolyphony(notes);
    const onsetDensity = (onsetCount + drums.length) / Math.max(0.25, input.durationSec);
    const onsetTimes = onsetGroups.map((group) => group[0]?.startSec ?? 0);
    const onsetGaps = onsetTimes.slice(1).map((time, index) => time - (onsetTimes[index] ?? 0));
    const medianOnsetGap = median(onsetGaps.filter((gap) => gap > 0.003));
    const medianDuration = median(durations);
    const longNoteRatio = notes.length > 0
      ? durations.filter((duration) => duration > Math.max(0.25, medianDuration * 2.5)).length /
        notes.length
      : 0;
    const durationToGapRatio = medianOnsetGap > 0 ? medianDuration / medianOnsetGap : 0;
    const layerRegularity = rhythmicLayerRegularity(notes);
    const melodicStepRatio = sequentialStepRatio(onsetGroups);
    const velocityVariation = normalizedDeviation(notes.map((note) => note.velocity));
    const hasDeclaredRhythm = drums.length > 0;
    const hasChordStructure =
      chordalOnsetRatio >= 0.35 || (simultaneousOnsetRatio >= 0.65 && maxOnsetGroup >= 3);
    const hasDurationSeparatedStreams = shortRatio >= 0.4 && longNoteRatio >= 0.2;
    const compactMelodicSequence =
      pitchCount >= 2 && pitchCount <= 7 && simultaneousOnsetRatio < 0.1 && melodicStepRatio >= 0.7;
    const hasStrongPitchedRhythm =
      notes.length >= 8 &&
      onsetDensity >= 2 &&
      repeatedLayerRatio >= 0.7 &&
      dominantLayerRatio >= 0.55 &&
      chordalOnsetRatio < 0.2 &&
      layerRegularity >= 0.5 &&
      (shortRatio >= 0.5 || durationToGapRatio >= 0.65) &&
      (pitchCount >= 6 || simultaneousOnsetRatio >= 0.1 || durationToGapRatio >= 0.8) &&
      !compactMelodicSequence;
    const hasAmbiguousRhythm =
      notes.length >= 6 && onsetDensity >= 2 && repeatedLayerRatio >= 0.55;

    let type: InputType;
    if (hasDeclaredRhythm && notes.length > 0) type = 'mixed';
    else if (hasDeclaredRhythm) type = 'rhythm';
    else if (hasChordStructure) type = 'polyphonic';
    else if (hasDurationSeparatedStreams) type = 'mixed';
    else if (hasStrongPitchedRhythm) type = 'rhythm';
    else if (hasAmbiguousRhythm) type = 'mixed';
    else if (maxPolyphony > 1) type = 'polyphonic';
    else type = 'melody';

    const confidence = hasDeclaredRhythm
      ? 0.98
      : hasChordStructure
        ? 0.94
        : hasStrongPitchedRhythm
          ? 0.9
          : type === 'mixed'
            ? 0.62
            : notes.length >= 4 ? 0.82 : 0.7;
    const scores: Record<InputType, number> = {
      melody: type === 'melody' ? confidence : (1 - confidence) / 4,
      polyphonic: type === 'polyphonic' ? confidence : (1 - confidence) / 4,
      rhythm: type === 'rhythm' ? confidence : (1 - confidence) / 4,
      mixed: type === 'mixed' ? confidence : (1 - confidence) / 4,
      unknown: (1 - confidence) / 4,
    };
    const features = {
      noteCount: notes.length,
      drumCount: drums.length,
      onsetCount,
      pitchCount,
      shortNoteRatio: shortRatio,
      medianDuration,
      longNoteRatio,
      medianOnsetGap,
      durationToGapRatio,
      maxPolyphony,
      maxOnsetGroup,
      onsetDensity,
      simultaneousOnsetRatio,
      chordalOnsetRatio,
      dominantLayerRatio,
      repeatedLayerRatio,
      layerRegularity,
      melodicStepRatio,
      velocityVariation,
      trackCount: input.trackCount,
    };

    return {
      type,
      confidence,
      scores,
      features,
      reasoning: midiReasoning(type, features, hasDeclaredRhythm),
      method: 'automatic',
    };
  }
}

export const inputClassifier = new InputClassifier();

export function classifyInput(audio: MonoAudio): InputClassification {
  return inputClassifier.classify(audio);
}

export function classifyMidiInput(input: MidiClassificationInput): InputClassification {
  return inputClassifier.classifyMidi(input);
}

/** Records a post-detection correction without erasing the classifier's evidence. */
export function correctClassification(
  classification: InputClassification,
  type: 'melody' | 'rhythm',
): InputClassification {
  return {
    ...classification,
    type,
    confidence: 1,
    method: 'user-corrected',
    originalType: classification.originalType ?? classification.type,
    reasoning: [...classification.reasoning, `user_corrected_route=${type}`],
  };
}

export function reconcileClassificationWithMaterial(
  classification: InputClassification,
  noteCount: number,
  drumCount: number,
): InputClassification {
  if (classification.type !== 'mixed' || noteCount > 0 || drumCount === 0) return classification;
  return {
    ...classification,
    type: 'rhythm',
    reasoning: [
      ...classification.reasoning,
      'mixed_pitch_branch_empty; presenting preserved rhythm material',
    ],
  };
}

function audioReasoning(
  type: InputType,
  features: IntentFeatures,
  scores: Record<InputType, number>,
): string[] {
  const reasons = [
    `route=${type}; score=${scores[type].toFixed(3)}`,
    `voiced_ratio=${features.voicedRatio.toFixed(3)}; pitch_stability=${features.pitchStability.toFixed(3)}`,
    `onset_rate=${features.onsetRate.toFixed(3)}; attack_sharpness=${features.attackSharpness.toFixed(3)}`,
  ];
  if (type === 'melody') reasons.push('continuous pitched evidence favours the existing human-melody tracker');
  if (type === 'polyphonic') reasons.push('pitched attacks favour multipitch transcription');
  if (type === 'rhythm') reasons.push('transient evidence dominates pitched continuity');
  if (type === 'mixed') reasons.push('pitched continuity and repeated transient evidence are both material');
  if (type === 'unknown') reasons.push('no route had enough musical evidence to process safely');
  return reasons;
}

function midiReasoning(
  type: InputType,
  features: Record<string, number>,
  hasDeclaredRhythm: boolean,
): string[] {
  return [
    `route=${type}; source=midi`,
    `notes=${features.noteCount}; drums=${features.drumCount}; tracks=${features.trackCount}`,
    `onset_density=${features.onsetDensity?.toFixed(3)}; repeated_layers=${features.repeatedLayerRatio?.toFixed(3)}`,
    `chordal_onsets=${features.chordalOnsetRatio?.toFixed(3)}; max_polyphony=${features.maxPolyphony}`,
    hasDeclaredRhythm
      ? 'the file explicitly contains General MIDI percussion material'
      : 'routing was inferred from event duration, density, and overlap; channel absence was not treated as intent',
  ];
}

function groupNotesByOnset(notes: readonly NoteEvent[], toleranceSec = 0.003): NoteEvent[][] {
  const groups: NoteEvent[][] = [];
  for (const note of [...notes].sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch)) {
    const current = groups[groups.length - 1];
    const anchor = current?.[0]?.startSec;
    if (!current || anchor === undefined || Math.abs(note.startSec - anchor) > toleranceSec) {
      groups.push([note]);
    } else {
      current.push(note);
    }
  }
  return groups;
}

function isChordLikeGroup(group: readonly NoteEvent[]): boolean {
  const pitches = [...new Set(group.map((note) => note.pitch))].sort((a, b) => a - b);
  if (pitches.length < 2) return false;
  const intervals: number[] = [];
  for (let left = 0; left < pitches.length; left += 1) {
    for (let right = left + 1; right < pitches.length; right += 1) {
      intervals.push(((pitches[right] as number) - (pitches[left] as number)) % 12);
    }
  }
  const hasThird = intervals.some((interval) => interval === 3 || interval === 4);
  const hasChordSpan = intervals.some((interval) => [7, 8, 9].includes(interval));
  return hasThird && (pitches.length === 2 || hasChordSpan);
}

function countBy(values: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function rhythmicLayerRegularity(notes: readonly NoteEvent[]): number {
  const byPitch = new Map<number, number[]>();
  for (const note of notes) {
    const starts = byPitch.get(note.pitch) ?? [];
    starts.push(note.startSec);
    byPitch.set(note.pitch, starts);
  }
  let weighted = 0;
  let weight = 0;
  for (const starts of byPitch.values()) {
    if (starts.length < 4) continue;
    starts.sort((a, b) => a - b);
    const gaps = starts.slice(1).map((time, index) => time - (starts[index] ?? 0));
    const centre = median(gaps);
    if (centre <= 0) continue;
    const regular = gaps.filter((gap) => {
      const multiple = Math.max(1, Math.round(gap / centre));
      return Math.abs(gap - centre * multiple) <= Math.max(0.025, centre * 0.18);
    }).length / gaps.length;
    weighted += regular * starts.length;
    weight += starts.length;
  }
  return weight > 0 ? weighted / weight : 0;
}

function sequentialStepRatio(groups: readonly NoteEvent[][]): number {
  if (groups.length < 2) return 0;
  const centres = groups.map((group) => median(group.map((note) => note.pitch)));
  const intervals = centres.slice(1).map((pitch, index) => Math.abs(pitch - (centres[index] ?? pitch)));
  return intervals.filter((interval) => interval > 0 && interval <= 12).length / intervals.length;
}

function normalizedDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  if (average <= 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return clamp01(Math.sqrt(variance) / average);
}

function maximumPolyphony(notes: readonly NoteEvent[]): number {
  const points = notes.flatMap((note) => [
    { time: note.startSec, delta: 1 },
    { time: note.endSec, delta: -1 },
  ]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

/**
 * Normalized autocorrelation peak — how periodic a frame is.
 *
 * A cheap proxy for "does this have a pitch": a sung vowel peaks near 1, a
 * cymbal or a consonant stays low. Much cheaper than a full pitch track, which
 * matters because this runs before the app has decided which engine to use.
 */
function periodicityOf(frame: Float32Array): number {
  const size = frame.length;
  const half = size >> 1;
  let energy = 0;
  for (let i = 0; i < half; i += 1) energy += (frame[i] as number) ** 2;
  if (energy <= 1e-9) return 0;

  let best = 0;
  // 40 Hz to 1.2 kHz at 44.1 kHz covers every human and most melodic ranges.
  const minLag = 36;
  const maxLag = Math.min(half - 1, 1102);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < half; i += 1) sum += (frame[i] as number) * (frame[i + lag] as number);
    const normalized = sum / energy;
    if (normalized > best) best = normalized;
  }
  return clamp01(best);
}

/**
 * Syllabic singing contains short vowel islands separated by consonants. Soft
 * attacks and stable periodicity distinguish those islands from re-attacked
 * plucks even when their mean voiced run is only a few frames long.
 */
function syllabicVoiceEvidence(features: IntentFeatures): number {
  return clamp01(
    ramp(features.voicedRatio, 0.2, 0.5) *
      features.pitchStability *
      inverse(ramp(features.attackSharpness, 0.18, 0.45)) *
      ramp(features.onsetRate, 0.12, 0.55) *
      inverse(ramp(features.onsetRate, 1, 2)) *
      inverse(ramp(features.highRatio, 0.1, 0.35)) *
      2.2,
  );
}

function voicedRuns(voiced: readonly boolean[]): number[] {
  const runs: number[] = [];
  let current = 0;
  for (const isVoiced of voiced) {
    if (isVoiced) current += 1;
    else if (current > 0) {
      runs.push(current);
      current = 0;
    }
  }
  if (current > 0) runs.push(current);
  return runs;
}

/** How consistent periodicity is inside voiced frames: steady pitch scores high. */
function stabilityOf(periodicities: readonly number[], voiced: readonly boolean[]): number {
  const values = periodicities.filter((_, i) => voiced[i]);
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return clamp01(1 - Math.sqrt(variance) / 0.35);
}

/** Energy rises that look like attacks. */
function countAttacks(energies: readonly number[]): number {
  const threshold = Math.max(0.01, median(energies) * 1.5);
  let count = 0;
  for (let i = 1; i < energies.length; i += 1) {
    const previous = energies[i - 1] as number;
    const current = energies[i] as number;
    if (current > threshold && current > previous * 1.6) count += 1;
  }
  return count;
}

/** How abruptly energy rises at attacks, 0..1. Plucks and hits are high. */
function sharpnessOf(energies: readonly number[]): number {
  const rises: number[] = [];
  for (let i = 1; i < energies.length; i += 1) {
    const previous = Math.max(1e-6, energies[i - 1] as number);
    const current = energies[i] as number;
    if (current > previous) rises.push(Math.min(8, current / previous));
  }
  if (rises.length === 0) return 0;
  rises.sort((a, b) => b - a);
  // The strongest tenth of rises: a single attack should not be diluted by the
  // long stretches of steady tone around it.
  const top = rises.slice(0, Math.max(1, Math.floor(rises.length * 0.1)));
  return clamp01((mean(top) - 1) / 4);
}

function ramp(value: number, from: number, to: number): number {
  if (to === from) return value >= to ? 1 : 0;
  return clamp01((value - from) / (to - from));
}

function inverse(value: number): number {
  return clamp01(1 - value);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
