/**
 * US-0605 / US-0606 / US-0607 - playback, the offline render, and the master bus.
 *
 * Playback and render share one graph builder, so what the user auditions and
 * what lands in the WAV cannot drift apart. The only difference is which context
 * the nodes are created on.
 */

import { AppError, type DrumEvent, type NoteEvent } from '@contracts';
import { ProceduralEngine } from './procedural';
import { getInstrument } from './registry';
import { SampleEngine } from './sample';
import type { InstrumentDefinition, PreparedInstrument, SynthEngine } from './types';

/**
 * Engines in preference order. The sample engine wins wherever an instrument
 * declares a pack; the procedural engine is the floor that always answers.
 * Adding `js-synthesizer` later means adding one entry here.
 */
export const ENGINES: readonly SynthEngine[] = [new SampleEngine(), new ProceduralEngine()];

export function selectEngine(instrument: InstrumentDefinition): SynthEngine {
  const engine = ENGINES.find((candidate) => candidate.supports(instrument));
  if (!engine) {
    throw new AppError('instrument_load_failed', 'choose_other_instrument', instrument.id);
  }
  return engine;
}

export interface MasterSettings {
  /** 0..1, applied as gain. Default is unity-ish with headroom for peaks. */
  volume: number;
  /** 0..1 wet mix. 0 disables the convolver entirely rather than running it dry. */
  reverb: number;
}

export const DEFAULT_MASTER: MasterSettings = { volume: 0.85, reverb: 0.18 };

/**
 * A short synthetic hall.
 *
 * Generated rather than loaded: an impulse response file would be another asset
 * with another licence, and the product needs a room, not a specific room. The
 * decay is exponential over 1.6 s with an early-reflection bump, which is enough
 * to stop a dry synthesised note sounding like it was recorded inside a box.
 * Deterministic seed, so renders stay reproducible.
 */
export function createReverbImpulse(context: BaseAudioContext, seconds = 1.6): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  let state = 0x2545f491;
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const noise = (state / 0x7fffffff) % 1;
      const t = i / length;
      const decay = (1 - t) ** 2.6;
      // Early reflections in the first 40 ms give the tail a sense of size.
      const early = i < context.sampleRate * 0.04 ? 1.7 : 1;
      data[i] = noise * decay * early;
    }
  }
  return impulse;
}

export interface MasterBus {
  input: AudioNode;
  dispose(): void;
}

export function createMasterBus(
  context: BaseAudioContext,
  destination: AudioNode,
  settings: MasterSettings,
): MasterBus {
  const input = context.createGain();
  input.gain.value = 1;

  const master = context.createGain();
  master.gain.value = settings.volume;

  const dry = context.createGain();
  dry.gain.value = 1 - settings.reverb * 0.5;
  input.connect(dry);
  dry.connect(master);

  let convolver: ConvolverNode | null = null;
  if (settings.reverb > 0.001) {
    convolver = context.createConvolver();
    convolver.buffer = createReverbImpulse(context);
    const wet = context.createGain();
    wet.gain.value = settings.reverb * 0.6;
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(master);
  }

  // A limiter in all but name. A dense take can otherwise clip the render, and
  // clipping in an exported file is not recoverable by the user.
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -6;
  compressor.knee.value = 6;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.12;
  master.connect(compressor);
  compressor.connect(destination);

  return {
    input,
    dispose() {
      try {
        input.disconnect();
        dry.disconnect();
        master.disconnect();
        compressor.disconnect();
        convolver?.disconnect();
      } catch {
        // Context already closed.
      }
    },
  };
}

export interface RenderRequest {
  instrumentId: string;
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  durationSec: number;
  master?: MasterSettings;
  sampleRate?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  buffer: AudioBuffer;
  /** Wall-clock milliseconds the render took, for the performance budget. */
  elapsedMs: number;
  /** Ratio of render time to clip duration. The PRD target is <= 0.25. */
  realtimeRatio: number;
}

/**
 * Renders the sketch offline.
 *
 * The context runs as fast as the CPU allows, which is what makes the
 * faster-than-real-time target achievable without any special-casing. The tail
 * is padded by the instrument's own release so a final held note is not cut off
 * mid-decay - a truncated last note is the single most noticeable render bug.
 */
export async function renderSketch(request: RenderRequest): Promise<RenderResult> {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new AppError('render_failed', 'reload', 'OfflineAudioContext unavailable');
  }
  const instrument = getInstrument(request.instrumentId);
  if (!instrument) {
    throw new AppError('render_failed', 'choose_other_instrument', request.instrumentId);
  }

  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const sampleRate = request.sampleRate ?? 44100;
  const engine = selectEngine(instrument);

  // Probe the tail before sizing the context. Two seconds covers the longest
  // release plus the reverb, and the exact figure comes from the instrument.
  const tail = 2;
  const length = Math.max(1, Math.ceil((request.durationSec + tail) * sampleRate));
  const context = new OfflineAudioContext(2, length, sampleRate);

  request.onProgress?.(0.1);
  const prepared = await engine.prepare(instrument, context, (fraction) =>
    request.onProgress?.(0.1 + fraction * 0.3),
  );
  throwIfAborted(request.signal);

  const bus = createMasterBus(context, context.destination, request.master ?? DEFAULT_MASTER);
  scheduleInto(prepared, bus.input, request, 0);
  request.onProgress?.(0.5);

  const buffer = await context.startRendering();
  throwIfAborted(request.signal);
  prepared.dispose();
  bus.dispose();
  request.onProgress?.(1);

  const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  return {
    buffer,
    elapsedMs,
    realtimeRatio: request.durationSec > 0 ? elapsedMs / 1000 / request.durationSec : 0,
  };
}

function scheduleInto(
  prepared: PreparedInstrument,
  destination: AudioNode,
  request: Pick<RenderRequest, 'notes' | 'drums'>,
  originSec: number,
): void {
  if (request.notes.length > 0) {
    prepared.scheduleNotes(
      destination,
      request.notes.map((note) => ({
        pitch: note.pitch,
        velocity: note.velocity,
        startSec: note.startSec,
        endSec: note.endSec,
      })),
      originSec,
    );
  }
  if (request.drums.length > 0) {
    prepared.scheduleHits(
      destination,
      request.drums.map((drum) => ({
        drum: drum.drum,
        velocity: drum.velocity,
        startSec: drum.timeSec,
      })),
      originSec,
    );
  }
}

export interface PlaybackHandle {
  stop(): void;
  /** Context time the playback started, for the piano-roll cursor. */
  readonly startedAtSec: number;
}

/**
 * Real-time audition of the current sketch.
 *
 * Returns immediately; the caller drives the playhead from
 * `context.currentTime - startedAtSec`. Deriving the cursor from the audio clock
 * rather than a rAF counter is what keeps it aligned with what is heard
 * (interaction-motion skill: the audio clock is truth).
 */
export async function playSketch(
  context: AudioContext,
  request: Omit<RenderRequest, 'sampleRate' | 'onProgress'>,
): Promise<PlaybackHandle> {
  const instrument = getInstrument(request.instrumentId);
  if (!instrument) {
    throw new AppError('render_failed', 'choose_other_instrument', request.instrumentId);
  }
  const engine = selectEngine(instrument);
  const prepared = await engine.prepare(instrument, context);
  const bus = createMasterBus(context, context.destination, request.master ?? DEFAULT_MASTER);

  // Small lead so the first note is never scheduled in the past.
  const origin = context.currentTime + 0.08;
  scheduleInto(prepared, bus.input, request, origin);

  return {
    startedAtSec: origin,
    stop() {
      prepared.dispose();
      bus.dispose();
    },
  };
}

/** US-0604 - the gallery preview gesture, using the instrument's own pattern. */
export async function previewInstrument(
  context: AudioContext,
  instrumentId: string,
  master: MasterSettings = DEFAULT_MASTER,
): Promise<PlaybackHandle> {
  const instrument = getInstrument(instrumentId);
  if (!instrument) {
    throw new AppError('instrument_load_failed', 'choose_other_instrument', instrumentId);
  }
  const pattern = instrument.previewPattern;
  return instrument.mode === 'rhythm'
    ? playSketch(context, {
        instrumentId,
        notes: [],
        drums: pattern.map((note) => ({
          timeSec: note.startSec,
          drum: note.pitch === 36 ? 'kick' : note.pitch === 38 ? 'snare' : 'hat',
          velocity: note.velocity,
          confidence: 1,
        })),
        durationSec: 1.5,
        master,
      })
    : playSketch(context, {
        instrumentId,
        notes: pattern.map((note) => ({
          startSec: note.startSec,
          endSec: note.endSec,
          pitch: note.pitch,
          velocity: note.velocity,
        })),
        drums: [],
        durationSec: 1.8,
        master,
      });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AppError('render_failed', 'retry', 'aborted');
}
