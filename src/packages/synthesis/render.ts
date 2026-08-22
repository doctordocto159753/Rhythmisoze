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
import type {
  InstrumentDefinition,
  InstrumentQuality,
  PreparedInstrument,
  SynthEngine,
} from './types';

/**
 * Engines in preference order. The sample engine wins wherever an instrument
 * declares a pack; the procedural engine is the floor that always answers.
 * Adding `js-synthesizer` later means adding one entry here.
 */
const sampleEngine = new SampleEngine();
const proceduralEngine = new ProceduralEngine();
export const ENGINES: readonly SynthEngine[] = [sampleEngine, proceduralEngine];

export function selectEngine(instrument: InstrumentDefinition): SynthEngine {
  const engine = ENGINES.find((candidate) => candidate.supports(instrument));
  if (!engine) {
    throw new AppError('instrument_load_failed', 'choose_other_instrument', instrument.id);
  }
  return engine;
}

export interface InstrumentPreparation {
  prepared: PreparedInstrument;
  engineId: string;
  fellBack: boolean;
}

export interface PrepareInstrumentOptions {
  quality?: InstrumentQuality;
  onProgress?: (fraction: number) => void;
}

/** Minimal devices keep a reliable synth floor; desktop remains sample-first. */
export function recommendedInstrumentQuality(): Exclude<InstrumentQuality, 'auto'> {
  if (typeof navigator === 'undefined') return 'sample';
  const nav = navigator as Navigator & { deviceMemory?: number };
  if ((nav.deviceMemory !== undefined && nav.deviceMemory <= 2) || nav.hardwareConcurrency <= 2) {
    return 'synth';
  }
  return 'sample';
}

async function prepareInstrumentDefinition(
  instrument: InstrumentDefinition,
  context: BaseAudioContext,
  options: PrepareInstrumentOptions = {},
): Promise<InstrumentPreparation> {
  const quality = options.quality === undefined || options.quality === 'auto'
    ? recommendedInstrumentQuality()
    : options.quality;
  const candidates = quality === 'synth' || instrument.type === 'synth'
    ? [proceduralEngine]
    : [sampleEngine, proceduralEngine];
  let lastError: unknown = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const engine = candidates[index] as SynthEngine;
    if (!engine.supports(instrument)) continue;
    try {
      const prepared = await engine.prepare(instrument, context, options.onProgress);
      options.onProgress?.(1);
      return {
        prepared,
        engineId: engine.id,
        fellBack: index > 0 || (quality === 'synth' && instrument.type === 'sample'),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new AppError('instrument_load_failed', 'choose_other_instrument', instrument.id);
}

/** Explicit lazy-load API used by the gallery on selection and preview. */
export async function preloadInstrument(
  context: BaseAudioContext,
  instrumentId: string,
  options: PrepareInstrumentOptions = {},
): Promise<Omit<InstrumentPreparation, 'prepared'>> {
  const instrument = getInstrument(instrumentId);
  if (!instrument) throw new AppError('instrument_load_failed', 'choose_other_instrument', instrumentId);
  const result = await prepareInstrumentDefinition(instrument, context, options);
  result.prepared.dispose();
  return { engineId: result.engineId, fellBack: result.fellBack };
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

/**
 * How long the material being played actually lasts, in seconds.
 *
 * ## Two durations, not one
 *
 * A sketch has a *source duration* — how long the person hummed — and a
 * *musical duration* — how long the version they are listening to runs. For the
 * Judge and the Teacher these are near enough the same number that one variable
 * served for both. For the Musician they are not: Expanded is explicitly allowed
 * to grow the idea, and a real 10.14 s take came back as a 38.74 s passage.
 *
 * The renderer sized its offline context from the source duration, so the WAV
 * was 10.14 s of music plus the release tail and stopped there — 12.14 s of a
 * 38.74 s piece, with the rest silently absent. Nothing errored; the file was
 * just short. Deriving the length from the notes that will actually be
 * scheduled is what makes that unrepresentable.
 *
 * `floorSec` is the source duration where it still matters: a take with trailing
 * silence after the last note should still render its full length, which is the
 * behaviour every non-generated version already had.
 *
 * The synthesis tail — release and reverb — is deliberately *not* included. It
 * is appended by the renderer on top of this value, because it is decay after
 * the music rather than part of it, and baking it in here would make every
 * subsequent length calculation drift by a tail.
 */
export function musicalDurationSec(
  notes: readonly NoteEvent[],
  drums: readonly DrumEvent[],
  floorSec = 0,
): number {
  let end = Number.isFinite(floorSec) && floorSec > 0 ? floorSec : 0;
  for (const note of notes) {
    if (Number.isFinite(note.endSec) && note.endSec > end) end = note.endSec;
  }
  for (const drum of drums) {
    // A drum event has an onset and no length; its decay lives in the render
    // tail, exactly like a note's release does.
    if (Number.isFinite(drum.timeSec) && drum.timeSec > end) end = drum.timeSec;
  }
  return end;
}

export interface RenderRequest {
  instrumentId: string;
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  /**
   * How much music to render, in seconds — the *musical* duration of what is
   * being played, not the duration of the recording it came from. See
   * `musicalDurationSec`. The release and reverb tail is added on top of this.
   */
  durationSec: number;
  master?: MasterSettings;
  sampleRate?: number;
  quality?: InstrumentQuality;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  buffer: AudioBuffer;
  /** Wall-clock milliseconds the render took, for the performance budget. */
  elapsedMs: number;
  /** Ratio of render time to clip duration. The PRD target is <= 0.25. */
  realtimeRatio: number;
  engineId: string;
  fellBack: boolean;
}

/**
 * Renders the sketch offline.
 *
 * The context runs as fast as the CPU allows, which is what makes the
 * faster-than-real-time target achievable without any special-casing. The tail
 * is padded by the instrument's own release so a final held note is not cut off
 * mid-decay - a truncated last note is the single most noticeable render bug.
 *
 * `durationSec` is the *musical* length of what is being rendered, and acts as a
 * floor rather than a ceiling: see `musicalDurationSec`.
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
  // Natural sample tail plus the generated room. Procedural instruments retain
  // the original two-second floor; the recorded kit needs its full room decay.
  const tail = Math.max(2, (instrument.renderTailSec ?? 0.4) + 1.6);
  // An invariant, not a fallback: the render is never shorter than the material
  // it was handed. A buffer sized below the last scheduled event produces a file
  // that is quietly missing the end of the piece, with no error anywhere — which
  // is exactly how a 38.74 s Musician passage came out as a 12.14 s WAV. The
  // caller still passes the right duration; this makes the wrong one harmless.
  const musicalSec = musicalDurationSec(request.notes, request.drums, request.durationSec);
  const length = Math.max(1, Math.ceil((musicalSec + tail) * sampleRate));
  const context = new OfflineAudioContext(2, length, sampleRate);

  request.onProgress?.(0.1);
  const preparation = await prepareInstrumentDefinition(instrument, context, {
    quality: request.quality,
    onProgress: (fraction) => request.onProgress?.(0.1 + fraction * 0.3),
  });
  const prepared = preparation.prepared;
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
    // Against the music actually rendered, so the performance budget is not
    // flattered by a long version that was measured as a short one.
    realtimeRatio: musicalSec > 0 ? elapsedMs / 1000 / musicalSec : 0,
    engineId: preparation.engineId,
    fellBack: preparation.fellBack,
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
        tuneSemitones: drum.tuneSemitones,
      })),
      originSec,
    );
  }
}

export interface PlaybackHandle {
  stop(): void;
  /** Context time the playback started, for the piano-roll cursor. */
  readonly startedAtSec: number;
  readonly engineId: string;
  readonly fellBack: boolean;
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
  const preparation = await prepareInstrumentDefinition(instrument, context, {
    quality: request.quality,
  });
  const prepared = preparation.prepared;
  const bus = createMasterBus(context, context.destination, request.master ?? DEFAULT_MASTER);

  // Small lead so the first note is never scheduled in the past.
  const origin = context.currentTime + 0.08;
  scheduleInto(prepared, bus.input, request, origin);

  return {
    startedAtSec: origin,
    engineId: preparation.engineId,
    fellBack: preparation.fellBack,
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
