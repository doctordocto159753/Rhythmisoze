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
  drum: DrumClass;
  velocity: number;
  confidence: number;
  /**
   * The MIDI note this hit was written as, when it came from a file that used
   * pitched notes rather than the percussion channel.
   *
   * Present so that reading a pitched rhythm into `drum` classes stays a
   * reading: the class is what the app plays, this is what the file said, and
   * the two can be compared. Absent for detected audio, which never had one.
   */
  sourcePitch?: number;
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
