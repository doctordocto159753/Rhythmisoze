/**
 * US-0601 - the synthesis adapter.
 *
 * Everything above this file - playback, offline render, the instrument gallery,
 * the preview button - talks to `SynthEngine` and `PreparedInstrument` and
 * nothing else. Swapping the sound source is then a change at the composition
 * root, which is the requirement: "UI depends on a synth adapter, not
 * engine-specific calls".
 *
 * Two engines implement it today (`procedural`, `sample`). A future
 * `js-synthesizer` or SpessaSynth engine implements the same three methods.
 */

import type { DrumClass, NoteEvent } from '@contracts';

export type InstrumentFamily = 'keys' | 'strings' | 'winds' | 'reeds' | 'percussion';
export type InstrumentCategory = 'melodic' | 'percussion';
export type InstrumentType = 'synth' | 'sample';
export type InstrumentQuality = 'auto' | 'sample' | 'synth';

export interface InstrumentLicense {
  /** SPDX identifier or an explicit human-readable grant. */
  spdx: string;
  /** Who made the sound and where it came from. Required for every entry. */
  source: string;
  url?: string;
  /** Attribution string that must appear in `docs/licenses` and the UI credits. */
  attribution?: string;
  /** Whether the product must show the attribution when it ships the sound. */
  attributionRequired: boolean;
  /** Explicit permission to redistribute the sound files with the application. */
  redistribution: boolean;
}

export interface InstrumentDefinition {
  id: string;
  /** Localized display names. Persian is authored, not machine-translated. */
  name: { en: string; fa: string };
  category: InstrumentCategory;
  /** Preferred sound source. The procedural engine remains a fallback for every entry. */
  type: InstrumentType;
  family: InstrumentFamily;
  /** Which creation mode this instrument belongs to. */
  mode: 'melody' | 'rhythm';
  /** General MIDI program number used on export, 0..127. */
  gmProgram: number;
  /** Lowest and highest MIDI note the instrument is voiced for. */
  range: { low: number; high: number };
  /** Notes for the preview gesture, relative to the instrument's centre. */
  previewPattern: ReadonlyArray<{ pitch: number; startSec: number; endSec: number; velocity: number }>;
  /** Feeling-first metadata shown in the picker rather than sampler terminology. */
  mood: { en: readonly string[]; fa: readonly string[] };
  bestFor: { en: readonly string[]; fa: readonly string[] };
  /** Neutral visual fingerprint; the UI must not import procedural voice recipes. */
  visualProfile: readonly number[];
  license: InstrumentLicense;
  /**
   * Relative path to a sample-pack manifest, when one exists. `null` means the
   * instrument is voiced by the procedural engine. See
   * `docs/licenses/instruments.md` for the current state of every entry.
   */
  samplePack: string | null;
  /** Approximate download size in bytes when `samplePack` is set. */
  samplePackBytes?: number;
  /** Maximum natural sample/release tail used to size OfflineAudioContext. */
  renderTailSec?: number;
}

/**
 * Product-level instrument contract.
 *
 * OfflineAudioContext renders asynchronously, so the story's synchronous
 * `render(): AudioBuffer` sketch is represented honestly as a Promise. The
 * renderer depends on this contract, never on a sampler or oscillator class.
 */
export interface Instrument {
  readonly id: string;
  readonly name: { en: string; fa: string };
  readonly category: InstrumentCategory;
  readonly type: InstrumentType;
  preload(
    context: BaseAudioContext,
    onProgress?: (fraction: number) => void,
  ): Promise<void>;
  render(notes: readonly NoteEvent[], durationSec: number): Promise<AudioBuffer>;
}

export interface ScheduledNote {
  pitch: number;
  velocity: number;
  /** Seconds relative to the render/playback origin. */
  startSec: number;
  endSec: number;
}

export interface ScheduledHit {
  drum: DrumClass;
  velocity: number;
  startSec: number;
  /**
   * Semitones to shift the kit sound by. See `DrumEvent.tuneSemitones`.
   *
   * Optional and defaulting to none, so every existing caller and both engines
   * behave exactly as they did for material that has no such opinion.
   */
  tuneSemitones?: number;
}

/** An instrument that has finished loading and can be scheduled. */
export interface PreparedInstrument {
  readonly instrumentId: string;
  readonly engineId: string;
  /**
   * Schedules notes onto the graph. `originSec` is an absolute time on the
   * context clock, which is what makes the same call work for realtime playback
   * and for an `OfflineAudioContext` render.
   */
  scheduleNotes(destination: AudioNode, notes: readonly ScheduledNote[], originSec: number): void;
  scheduleHits(destination: AudioNode, hits: readonly ScheduledHit[], originSec: number): void;
  /** Longest tail this instrument can produce, so renders are not truncated. */
  readonly releaseTailSec: number;
  dispose(): void;
}

export interface SynthEngine {
  readonly id: string;
  /** Whether this engine can voice the instrument at all. */
  supports(instrument: InstrumentDefinition): boolean;
  /**
   * Loads whatever the instrument needs. Resolves once it can be scheduled
   * without further I/O, so a caller can show a determinate loading state.
   */
  prepare(
    instrument: InstrumentDefinition,
    context: BaseAudioContext,
    onProgress?: (fraction: number) => void,
  ): Promise<PreparedInstrument>;
}
