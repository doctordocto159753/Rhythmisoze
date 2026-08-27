/**
 * Core musical value types.
 *
 * These are the vocabulary the whole product speaks. Nothing in here knows
 * about the DOM, Web Audio, React or any ML engine — that separation is what
 * lets the retouch engine be unit-tested in Node against golden fixtures.
 */

/** Contract version. Bump when a field changes meaning, not when one is added. */
export const CONTRACT_VERSION = 1 as const;

export const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export type PitchClassName = (typeof PITCH_CLASS_NAMES)[number];

export type KeyMode = 'major' | 'minor';

export interface MusicalKey {
  root: PitchClassName;
  mode: KeyMode;
  /** Krumhansl-Schmuckler correlation, -1..1. Low values mean "do not trust this". */
  confidence: number;
}

/** How many beats in a bar, and which note value gets the beat. */
export interface Meter {
  beatsPerBar: number;
  beatUnit: 2 | 4 | 8;
}

export const DEFAULT_METER: Meter = { beatsPerBar: 4, beatUnit: 4 };

/** Quantization grid, expressed as the note value a step represents. */
export type GridDivision = 8 | 16 | 32;

export const BPM_MIN = 40;
export const BPM_MAX = 200;

export type CreationMode = 'melody' | 'rhythm';

/**
 * A note in absolute seconds. This is the normalized output of *any*
 * transcriber (browser model, pitch tracker, or a future server backend) and
 * the input of the retouch engine.
 */
export interface NoteEvent {
  /** Seconds from the start of the recording. */
  startSec: number;
  /** Seconds from the start of the recording. Always > startSec. */
  endSec: number;
  /** MIDI note number, 0..127. */
  pitch: number;
  /** MIDI velocity, 1..127. */
  velocity: number;
  /** Model/tracker confidence 0..1 where the backend can supply one. */
  confidence?: number;
  /** Original MIDI track/channel/order. Preserved through derived versions when present. */
  sourceTrack?: number;
  sourceChannel?: number;
  sourceOrder?: number;
  sourceStartTicks?: number;
  sourceEndTicks?: number;
}

/** The immutable first musical reading of a source. */
export type RawSourceKind = 'audio' | 'midi';

/** Engine identity travels with Raw so a model change can never look like the same evidence. */
export interface RawTranscriptionProvenance {
  source: 'game' | 'midi' | 'rhythm-extraction';
  transcriber: 'game' | 'midi-import' | 'rhythm-extraction';
  model: string;
  modelVersion: string;
  /**
   * How the transcriber ran. `upstream-cli` is GAME's own `infer.py`, which is
   * the only way audio is transcribed now; `pytorch` and `onnx` remain readable
   * because Raw already written under those names must keep parsing.
   */
  backend: 'upstream-cli' | 'pytorch' | 'onnx' | 'midi-parser' | 'server-dsp';
}

/** A note exactly as the authoritative transcriber supplied it. */
export interface RawNoteEvent {
  startSec: number;
  endSec: number;
  /** Discrete MIDI note identity. GAME's fractional estimate remains beside it. */
  pitchMidi: number;
  continuousPitch?: number;
  velocity?: number;
  confidence?: number;
  /** Source MIDI identity. Absent for audio-derived notes. */
  sourceTrack?: number;
  sourceChannel?: number;
  sourceOrder?: number;
  /** Exact source-MIDI clock positions. Seconds remain the common product clock. */
  sourceStartTicks?: number;
  sourceEndTicks?: number;
}

export interface RawMidiTempoEvent {
  ticks: number;
  bpm: number;
  timeSec: number;
  sourceTrack?: number;
  sourceOrder?: number;
}

export interface RawMidiTimeSignatureEvent {
  ticks: number;
  timeSignature: readonly [number, number];
  timeSec: number;
  sourceTrack?: number;
  sourceOrder?: number;
}

export interface RawMidiMetadata {
  format: number;
  ppq: number;
  trackCount: number;
  tempos: readonly RawMidiTempoEvent[];
  timeSignatures: readonly RawMidiTimeSignatureEvent[];
}

/**
 * The source-faithful boundary between transcription/import and every derived
 * musical operation. Consumers may copy it; they may never rewrite it.
 */
export interface RawTranscription {
  version: 1;
  sourceKind: RawSourceKind;
  notes: readonly RawNoteEvent[];
  drums: readonly DrumEvent[];
  provenance: Readonly<RawTranscriptionProvenance>;
  sourceDurationSec: number;
  midi?: Readonly<RawMidiMetadata>;
}

/** Where a phrase interpretation came from. */
export type MusicalPhraseSourceKind = 'voice' | 'symbolic' | 'polyphonic';

/**
 * One frame of physical evidence retained beside the musical interpretation.
 *
 * `detectedPitch` is the accepted contour. `candidatePitch` is what YIN heard
 * before the voicing decision, so a rejected frame is not confused with a
 * frame that was never measured.
 */
export interface MusicalFrameEvidence {
  timeSec: number;
  detectedPitch: number | null;
  candidatePitch: number | null;
  energy: number;
  clarity: number;
  voiced: boolean;
}

/** Physical observations. These are never rewritten by phrase interpretation. */
export interface MusicalSourceEvidence {
  /** Exact transcriber/Judge candidate supplied to the representation layer. */
  notes: NoteEvent[];
  /** Detected attacks in absolute performance time. */
  onsetsSec: number[];
  /** Present for voice extraction; symbolic sources have no acoustic frames. */
  frames?: MusicalFrameEvidence[];
}

export type NoteArticulation = 'legato' | 'rearticulated' | 'detached';

/** Why two consecutive interpreted notes were, or were not, connected. */
export interface NoteConnectionEvidence {
  gapSec: number;
  intervalSemitones: number;
  /** Gap energy relative to the two sounding edges, clamped to 0..1. */
  energyContinuity: number;
  /** Longest genuinely quiet run inside the gap. */
  maxSilenceSec: number;
  onsetNearNext: boolean;
  reasoning: string[];
}

/** Relationship between two consecutive notes in the interpreted line. */
export interface MusicalNoteConnection {
  fromNoteIndex: number;
  toNoteIndex: number;
  articulation: NoteArticulation;
  confidence: number;
  evidence: NoteConnectionEvidence;
}

/** A connected gesture. Note indices are inclusive and refer to interpretedNotes. */
export interface MusicalPhrase {
  id: string;
  startNoteIndex: number;
  endNoteIndex: number;
  startSec: number;
  endSec: number;
  /** Signed semitone movements between adjacent notes. */
  contour: number[];
  confidence: number;
}

/** Observable before/after continuity measurements in seconds. */
export interface PhraseContinuityMetrics {
  sourceGapSec: number;
  interpretedInputGapSec: number;
  interpretedGapSec: number;
  reconstructedGapSec: number;
  connectedTransitions: number;
  detachedTransitions: number;
}

/**
 * Additive representation between transcription and the creative layers.
 *
 * Source evidence stays independent from interpreted notes. The latter may
 * reconstruct an evidence-backed vocal connection, but never moves an onset,
 * changes pitch, or quantizes expressive timing.
 */
export interface MusicalPhraseModel {
  version: 1;
  sourceKind: MusicalPhraseSourceKind;
  sourceEvidence: MusicalSourceEvidence;
  interpretedNotes: NoteEvent[];
  phrases: MusicalPhrase[];
  connections: MusicalNoteConnection[];
  expressiveTiming: true;
  metrics: PhraseContinuityMetrics;
}

/** A note already snapped to a grid. Times are integer grid steps. */
export interface GridNote {
  /** Onset in grid steps from zero. */
  step: number;
  /** Duration in grid steps. Always >= 1. */
  lengthSteps: number;
  pitch: number;
  velocity: number;
}

export type DrumClass = 'kick' | 'snare' | 'hat' | 'unknown';

export interface OnsetEvent {
  timeSec: number;
  /** Peak strength of the detection function at this onset, normalized 0..1. */
  strength: number;
  /** Spectral features used for classification, kept for diagnostics/tests. */
  features: OnsetFeatures;
}

export interface OnsetFeatures {
  /** Spectral centroid in Hz. */
  centroidHz: number;
  /** Fraction of energy below 250 Hz, 0..1. */
  lowRatio: number;
  /** Fraction of energy above 4 kHz, 0..1. */
  highRatio: number;
  /** Zero-crossing rate of the attack window, 0..1. */
  zeroCrossingRate: number;
  /** Peak RMS of the attack window, 0..1. */
  peak: number;
  /** Estimated decay time in seconds. */
  decaySec: number;
}

export interface DrumEvent {
  timeSec: number;
  /**
   * Which kit sound plays this hit.
   *
   * A *playback assignment*, not an identity. The synthesised kit has three
   * slots, and a rhythm may well have more layers than that, so two unrelated
   * parts can legitimately share a sound. What tells them apart is `voice`.
   */
  drum: DrumClass;
  velocity: number;
  confidence: number;
  /**
   * Which rhythmic layer this hit belongs to, as finely as the source knows.
   *
   * ## Why this is not `drum`
   *
   * They used to be the same field, and that cost a real user eight hits. Their
   * imported rhythm had fifteen distinct pitched layers; the kit has three
   * sounds; so the adapter mapped fifteen onto three, and the quantizer — which
   * merges two hits of "the same drum" landing on one step — then read two
   * *different* parts as a duplicate of each other and deleted one. Every event
   * lost at the default cleanup was lost that way. None of them was a duplicate
   * of anything.
   *
   * The identity is whatever the source is actually able to distinguish: the
   * note number for a MIDI file, the detected class for audio, which is all a
   * detector knows. Absent means "no finer identity than `drum`", which is the
   * honest reading for anything that never had one.
   */
  voice?: string;
  /**
   * The MIDI note this hit was written as, when it came from a file.
   *
   * Provenance: it answers "which source event is this?" after the hit has been
   * assigned a kit sound, and it is what a MIDI export writes back so a round
   * trip does not flatten the layers into three drums.
   */
  sourcePitch?: number;
  /**
   * The MIDI channel the hit was written on, zero-based.
   *
   * `GM_DRUM_CHANNEL` means the file declared these as General MIDI percussion,
   * and `sourcePitch` is then an instrument number rather than a pitch. Anything
   * else means the file used ordinary notes and said nothing about drums. The
   * distinction decides how an export writes them back, and it is a fact about
   * the source rather than something inferred from one.
   */
  sourceChannel?: number;
  /** Original track and event order, when this hit came from MIDI. */
  sourceTrack?: number;
  sourceOrder?: number;
  /** Original note-off time for a MIDI-encoded rhythmic event. */
  sourceEndSec?: number;
  /** Exact source-MIDI clock positions, when present. */
  sourceStartTicks?: number;
  sourceEndTicks?: number;
  /**
   * How far to shift the kit sound for this hit, in semitones.
   *
   * The other half of the playback assignment. A rhythm may have more layers
   * than the kit has sounds, so several share one — and if they also share the
   * pitch of that sound, a listener hears three parts where the file has
   * fifteen. Every event survives, every layer is in the data and the export,
   * and the thing coming out of the speaker is still a three-piece kit.
   *
   * Shifting each layer away from its slot's centre is what makes them audible
   * as separate parts. It is a tuning, not a transcription: absent means "play
   * the kit as it is", which is right for detected audio and for General MIDI,
   * where the sound already names the instrument.
   */
  tuneSemitones?: number;
}

/** General MIDI's percussion channel, zero-based. Channel 10 in one-based terms. */
export const GM_DRUM_CHANNEL = 9;

/**
 * The identity of the rhythmic layer a hit belongs to.
 *
 * Falls back to the playback assignment, which is the correct answer when the
 * source could not tell two layers apart in the first place.
 */
export function drumVoiceOf(event: DrumEvent): string {
  return event.voice ?? event.drum;
}

/** A drum hit already snapped to a grid. */
export interface GridDrum {
  step: number;
  drum: DrumClass;
  velocity: number;
}

/** General MIDI percussion note numbers for the MVP taxonomy. */
export const GM_DRUM_MAP: Readonly<Record<Exclude<DrumClass, 'unknown'>, number>> =
  Object.freeze({
    kick: 36,
    snare: 38,
    hat: 42,
  });

/**
 * `unknown` onsets are not dropped — dropping them would silently delete part
 * of the user's performance. They are voiced as a closed hat, which is the
 * least intrusive member of the kit, and kept flagged in diagnostics.
 */
export const UNKNOWN_DRUM_FALLBACK: DrumClass = 'hat';
