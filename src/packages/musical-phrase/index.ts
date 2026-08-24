/**
 * Evidence-preserving musical phrase interpretation.
 *
 * Transcription answers "what was measured?". This layer answers the smaller,
 * different question "which measured notes belong to one gesture?" It never
 * changes an onset or pitch, and it has no tempo/grid input. The only duration
 * change it can make is filling an acoustic dropout between two voice notes
 * when energy says the performance did not actually go silent.
 */

import type {
  MusicalFrameEvidence,
  MusicalNoteConnection,
  MusicalPhrase,
  MusicalPhraseModel,
  MusicalPhraseSourceKind,
  NoteConnectionEvidence,
  NoteEvent,
} from '@contracts';

export interface ContinuityFrame {
  timeSec: number;
  midiPitch: number | null;
  candidateMidi: number | null;
  rms: number;
  clarity: number;
  voiced: boolean;
}

export interface BuildMusicalPhraseOptions {
  sourceKind: MusicalPhraseSourceKind;
  /** Judge output when it differs from the untouched transcriber evidence. */
  interpretationNotes?: readonly NoteEvent[];
  frames?: readonly ContinuityFrame[];
  onsetsSec?: readonly number[];
  /** Acoustic voice gap ceiling. Deliberately absolute, never beat-derived. */
  maxConnectedGapSec?: number;
}

const DEFAULT_MAX_CONNECTED_GAP_SEC = 0.28;
const EDGE_WINDOW_SEC = 0.07;
const ONSET_WINDOW_SEC = 0.065;
const MAX_CONNECTED_INTERVAL = 12;
const SILENCE_ENERGY_RATIO = 0.18;
const MIN_ENERGY_CONTINUITY = 0.22;
const MAX_SILENCE_SEC = 0.085;
const TIME_EPSILON = 1e-6;

/** Build an observable phrase model without mutating either input array. */
export function buildMusicalPhraseModel(
  sourceNotes: readonly NoteEvent[],
  options: BuildMusicalPhraseOptions,
): MusicalPhraseModel {
  const evidenceNotes = cloneNotes(sourceNotes);
  const inputNotes = cloneNotes(options.interpretationNotes ?? sourceNotes);
  const frames = options.frames?.map(toFrameEvidence);
  const onsetsSec = [...(options.onsetsSec ?? defaultOnsets(options.sourceKind, evidenceNotes))];
  const sourceEvidence = {
    notes: evidenceNotes,
    onsetsSec,
    ...(frames === undefined ? {} : { frames }),
  };

  const sourceGapSec = totalSequentialGap(evidenceNotes);
  const interpretedInputGapSec = totalSequentialGap(inputNotes);

  // Chords are not a line of consecutive gestures. Keeping them exact is the
  // polyphonic safety rule; a future voice-leading layer may describe them,
  // but this monophonic phrase interpreter must not flatten or lengthen them.
  if (options.sourceKind === 'polyphonic' || !isOrderedMonophonic(inputNotes)) {
    return {
      version: 1,
      sourceKind: options.sourceKind,
      sourceEvidence,
      interpretedNotes: inputNotes,
      phrases: [],
      connections: [],
      expressiveTiming: true,
      metrics: {
        sourceGapSec,
        interpretedInputGapSec,
        interpretedGapSec: interpretedInputGapSec,
        reconstructedGapSec: 0,
        connectedTransitions: 0,
        detachedTransitions: 0,
      },
    };
  }

  const connections = options.sourceKind === 'voice'
    ? voiceConnections(inputNotes, frames ?? [], onsetsSec, options.maxConnectedGapSec)
    : symbolicConnections(inputNotes);
  const interpretedNotes = inputNotes.map((note) => ({ ...note }));

  // Fill only the missing occupancy between connected vocal notes. Onsets,
  // pitches and all true rests stay where the performance put them.
  if (options.sourceKind === 'voice') {
    for (const connection of connections) {
      if (connection.articulation === 'detached') continue;
      const current = interpretedNotes[connection.fromNoteIndex];
      const next = interpretedNotes[connection.toNoteIndex];
      if (!current || !next || next.startSec <= current.endSec) continue;
      current.endSec = next.startSec;
    }
  }

  const phrases = phrasesFrom(interpretedNotes, connections);
  const interpretedGapSec = totalSequentialGap(interpretedNotes);
  return {
    version: 1,
    sourceKind: options.sourceKind,
    sourceEvidence,
    interpretedNotes,
    phrases,
    connections,
    expressiveTiming: true,
    metrics: {
      sourceGapSec,
      interpretedInputGapSec,
      interpretedGapSec,
      reconstructedGapSec: round6(Math.max(0, interpretedInputGapSec - interpretedGapSec)),
      connectedTransitions: connections.filter((item) => item.articulation !== 'detached').length,
      detachedTransitions: connections.filter((item) => item.articulation === 'detached').length,
    },
  };
}

function voiceConnections(
  notes: readonly NoteEvent[],
  frames: readonly MusicalFrameEvidence[],
  onsetsSec: readonly number[],
  override?: number,
): MusicalNoteConnection[] {
  const maxGapSec = override ?? DEFAULT_MAX_CONNECTED_GAP_SEC;
  const hopSec = medianHop(frames);
  const connections: MusicalNoteConnection[] = [];

  for (let index = 0; index + 1 < notes.length; index += 1) {
    const current = notes[index] as NoteEvent;
    const next = notes[index + 1] as NoteEvent;
    const gapSec = Math.max(0, next.startSec - current.endSec);
    const intervalSemitones = next.pitch - current.pitch;
    const onsetNearNext = onsetsSec.some(
      (timeSec) => Math.abs(timeSec - next.startSec) <= ONSET_WINDOW_SEC,
    );
    const gapFrames = frames.filter(
      (frame) => frame.timeSec >= current.endSec - hopSec * 0.5
        && frame.timeSec <= next.startSec + hopSec * 0.5,
    );
    const beforeEnergy = percentile(
      frames
        .filter(
          (frame) => frame.timeSec >= current.endSec - EDGE_WINDOW_SEC
            && frame.timeSec <= current.endSec + hopSec,
        )
        .map((frame) => frame.energy),
      0.7,
    );
    const afterEnergy = percentile(
      frames
        .filter(
          (frame) => frame.timeSec >= next.startSec - hopSec
            && frame.timeSec <= next.startSec + EDGE_WINDOW_SEC,
        )
        .map((frame) => frame.energy),
      0.7,
    );
    const edgeEnergy = Math.min(beforeEnergy, afterEnergy);
    const interiorEnergy = percentile(gapFrames.map((frame) => frame.energy), 0.7);
    const energyContinuity = edgeEnergy > 0
      ? clamp01(interiorEnergy / edgeEnergy)
      : 0;
    const quietThreshold = Math.max(0.0008, edgeEnergy * SILENCE_ENERGY_RATIO);
    const maxSilenceSec = longestQuietRun(gapFrames, quietThreshold, hopSec);
    const intervalFits = Math.abs(intervalSemitones) <= MAX_CONNECTED_INTERVAL;
    const noMeasuredGap = gapSec <= Math.max(0.018, hopSec * 2.1);
    const acousticConnection =
      edgeEnergy > 0
      && energyContinuity >= MIN_ENERGY_CONTINUITY
      && maxSilenceSec <= Math.min(MAX_SILENCE_SEC, Math.max(hopSec, gapSec * 0.72));
    const connected =
      gapSec <= maxGapSec
      && intervalFits
      && (noMeasuredGap || acousticConnection);

    const reasoning = [
      gapSec <= maxGapSec ? 'transition is temporally close' : 'gap exceeds gesture window',
      intervalFits ? 'pitch movement is singable' : 'pitch movement exceeds voice-link limit',
      acousticConnection
        ? 'energy continues without a real silence'
        : noMeasuredGap
          ? 'notes touch within frame resolution'
          : 'acoustic evidence supports a separation',
      onsetNearNext ? 'an onset marks rearticulation' : 'no separate onset was measured',
    ];
    const evidence: NoteConnectionEvidence = {
      gapSec: round6(gapSec),
      intervalSemitones,
      energyContinuity: round6(energyContinuity),
      maxSilenceSec: round6(maxSilenceSec),
      onsetNearNext,
      reasoning,
    };
    const temporalScore = clamp01(1 - gapSec / Math.max(maxGapSec, 0.001));
    const silenceScore = gapSec <= TIME_EPSILON
      ? 1
      : clamp01(1 - maxSilenceSec / Math.max(gapSec, hopSec));
    const confidence = connected
      ? clamp01(0.35 * temporalScore + 0.4 * Math.max(energyContinuity, noMeasuredGap ? 1 : 0) + 0.25 * silenceScore)
      : clamp01(0.45 + 0.35 * (1 - temporalScore) + 0.2 * (1 - silenceScore));

    connections.push({
      fromNoteIndex: index,
      toNoteIndex: index + 1,
      articulation: connected ? (onsetNearNext ? 'rearticulated' : 'legato') : 'detached',
      confidence: round6(confidence),
      evidence,
    });
  }
  return connections;
}

/** Symbolic timing is descriptive only: relationships are added, durations are exact. */
function symbolicConnections(notes: readonly NoteEvent[]): MusicalNoteConnection[] {
  const durations = notes.map((note) => note.endSec - note.startSec).sort((a, b) => a - b);
  const medianDuration = median(durations);
  const phraseGapSec = Math.max(0.28, medianDuration * 1.6);
  const connections: MusicalNoteConnection[] = [];

  for (let index = 0; index + 1 < notes.length; index += 1) {
    const current = notes[index] as NoteEvent;
    const next = notes[index + 1] as NoteEvent;
    const gapSec = Math.max(0, next.startSec - current.endSec);
    const connected = gapSec < phraseGapSec;
    connections.push({
      fromNoteIndex: index,
      toNoteIndex: index + 1,
      articulation: connected ? (gapSec <= TIME_EPSILON ? 'legato' : 'rearticulated') : 'detached',
      confidence: 1,
      evidence: {
        gapSec: round6(gapSec),
        intervalSemitones: next.pitch - current.pitch,
        energyContinuity: 0,
        maxSilenceSec: round6(gapSec),
        onsetNearNext: true,
        reasoning: [
          connected ? 'symbolic notes share a phrase-sized interval' : 'symbolic rest marks a phrase break',
          'symbolic durations preserved exactly',
        ],
      },
    });
  }
  return connections;
}

function phrasesFrom(
  notes: readonly NoteEvent[],
  connections: readonly MusicalNoteConnection[],
): MusicalPhrase[] {
  if (notes.length === 0) return [];
  const phrases: MusicalPhrase[] = [];
  let startNoteIndex = 0;

  for (let index = 0; index < notes.length; index += 1) {
    const connection = connections[index];
    if (connection && connection.articulation !== 'detached') continue;
    const endNoteIndex = index;
    const phraseNotes = notes.slice(startNoteIndex, endNoteIndex + 1);
    const linkConfidence = connections
      .slice(startNoteIndex, endNoteIndex)
      .map((item) => item.confidence);
    const noteConfidence = phraseNotes.map((note) => note.confidence ?? 0.75);
    phrases.push({
      id: `phrase-${phrases.length + 1}`,
      startNoteIndex,
      endNoteIndex,
      startSec: (phraseNotes[0] as NoteEvent).startSec,
      endSec: (phraseNotes.at(-1) as NoteEvent).endSec,
      contour: phraseNotes.slice(1).map(
        (note, offset) => note.pitch - (phraseNotes[offset] as NoteEvent).pitch,
      ),
      confidence: round6(mean([...noteConfidence, ...linkConfidence])),
    });
    startNoteIndex = index + 1;
  }
  return phrases;
}

function toFrameEvidence(frame: ContinuityFrame): MusicalFrameEvidence {
  return {
    timeSec: frame.timeSec,
    detectedPitch: frame.midiPitch,
    candidatePitch: frame.candidateMidi,
    energy: frame.rms,
    clarity: frame.clarity,
    voiced: frame.voiced,
  };
}

function defaultOnsets(
  sourceKind: MusicalPhraseSourceKind,
  notes: readonly NoteEvent[],
): number[] {
  return sourceKind === 'voice' ? [] : notes.map((note) => note.startSec);
}

function isOrderedMonophonic(notes: readonly NoteEvent[]): boolean {
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index] as NoteEvent;
    if (!(note.endSec > note.startSec)) return false;
    const next = notes[index + 1];
    if (next && next.startSec < note.endSec - TIME_EPSILON) return false;
  }
  return true;
}

function totalSequentialGap(notes: readonly NoteEvent[]): number {
  let total = 0;
  for (let index = 1; index < notes.length; index += 1) {
    const previous = notes[index - 1] as NoteEvent;
    const current = notes[index] as NoteEvent;
    total += Math.max(0, current.startSec - previous.endSec);
  }
  return round6(total);
}

function longestQuietRun(
  frames: readonly MusicalFrameEvidence[],
  threshold: number,
  hopSec: number,
): number {
  let current = 0;
  let longest = 0;
  for (const frame of frames) {
    if (frame.energy < threshold) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest * hopSec;
}

function medianHop(frames: readonly MusicalFrameEvidence[]): number {
  if (frames.length < 2) return 0.01;
  const hops: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const hop = (frames[index] as MusicalFrameEvidence).timeSec
      - (frames[index - 1] as MusicalFrameEvidence).timeSec;
    if (hop > 0) hops.push(hop);
  }
  return median(hops) || 0.01;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function cloneNotes(notes: readonly NoteEvent[]): NoteEvent[] {
  return notes.map((note) => ({ ...note }));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}
