/**
 * Browser-native multisample engine. Packs are same-origin, manifest-driven,
 * loaded only on selection/play/render, and decoded once per tab.
 */
import { AppError } from '@contracts';
import type {
  InstrumentDefinition,
  PreparedInstrument,
  ScheduledHit,
  ScheduledNote,
  SynthEngine,
} from './types';

export interface SampleZone {
  file: string;
  rootMidi: number;
  lowMidi: number;
  highMidi: number;
  drum?: 'kick' | 'snare' | 'hat';
  minVelocity?: number;
  maxVelocity?: number;
  roundRobin?: number;
  loop?: { startSec: number; endSec: number } | null;
  bytes?: number;
  sha256?: string;
}

export interface SampleManifest {
  version: 1 | 2;
  id?: string;
  name?: string;
  type?: 'sample';
  license: {
    spdx: string;
    source: string;
    url?: string;
    attribution?: string;
    attributionRequired?: boolean;
    redistribution?: boolean;
  };
  playback?: { mode: 'natural' | 'gated'; releaseSec: number; tailSec?: number };
  samples?: Record<string, string>;
  zones: SampleZone[];
}

interface LoadedZone extends SampleZone { buffer: AudioBuffer }
interface LoadedPack {
  zones: LoadedZone[];
  playback: { mode: 'natural' | 'gated'; releaseSec: number; tailSec?: number };
}
interface CacheEntry {
  progress: number;
  listeners: Set<(fraction: number) => void>;
  promise: Promise<LoadedPack>;
}

const packCache = new Map<string, CacheEntry>();

function appError(detail: string): AppError {
  return new AppError('instrument_load_failed', 'choose_other_instrument', detail);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativeFile(file: string): boolean {
  return file.length > 0 && !file.startsWith('/') && !file.includes('\\') &&
    file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Runtime validation keeps a malformed or swapped manifest out of the audio graph. */
export function validateSampleManifest(
  input: unknown,
  instrument: InstrumentDefinition,
): SampleManifest {
  if (!isObject(input)) throw appError('manifest is not an object');
  if (input.version !== 1 && input.version !== 2) throw appError('unsupported manifest version');
  if (!isObject(input.license) || typeof input.license.spdx !== 'string' ||
      typeof input.license.source !== 'string') {
    throw appError('manifest licence is incomplete');
  }
  if (input.license.spdx !== instrument.license.spdx) throw appError('manifest licence mismatch');
  if (!Array.isArray(input.zones) || input.zones.length === 0) throw appError('manifest has no zones');

  const packId = instrument.samplePack?.split('/')[0];
  if (input.version === 2) {
    if (input.id !== packId) throw appError('manifest id mismatch');
    if (input.type !== 'sample') throw appError('manifest type mismatch');
    if (typeof input.name !== 'string' || input.name.length === 0) throw appError('manifest name missing');
    if (!isObject(input.samples)) throw appError('manifest sample map missing');
  }

  for (const candidate of input.zones) {
    if (!isObject(candidate) || typeof candidate.file !== 'string' || !isSafeRelativeFile(candidate.file)) {
      throw appError('unsafe sample path');
    }
    for (const field of ['rootMidi', 'lowMidi', 'highMidi'] as const) {
      if (!Number.isInteger(candidate[field]) || Number(candidate[field]) < 0 || Number(candidate[field]) > 127) {
        throw appError(`invalid ${field}`);
      }
    }
    if (Number(candidate.lowMidi) > Number(candidate.highMidi)) throw appError('inverted sample range');
    if (candidate.drum !== undefined && !['kick', 'snare', 'hat'].includes(String(candidate.drum))) {
      throw appError('invalid drum class');
    }
    const lowVelocity = candidate.minVelocity === undefined ? 1 : Number(candidate.minVelocity);
    const highVelocity = candidate.maxVelocity === undefined ? 127 : Number(candidate.maxVelocity);
    if (!Number.isInteger(lowVelocity) || !Number.isInteger(highVelocity) ||
        lowVelocity < 1 || highVelocity > 127 || lowVelocity > highVelocity) {
      throw appError('invalid velocity layer');
    }
    if (candidate.loop !== undefined && candidate.loop !== null) {
      if (!isObject(candidate.loop) || Number(candidate.loop.startSec) < 0 ||
          Number(candidate.loop.endSec) <= Number(candidate.loop.startSec)) {
        throw appError('invalid loop');
      }
    }
  }

  if (input.playback !== undefined) {
    if (!isObject(input.playback) || !['natural', 'gated'].includes(String(input.playback.mode)) ||
        !Number.isFinite(input.playback.releaseSec) || Number(input.playback.releaseSec) < 0) {
      throw appError('invalid playback settings');
    }
  }
  return input as unknown as SampleManifest;
}

class SampleInstrument implements PreparedInstrument {
  readonly engineId = 'sample';
  readonly releaseTailSec: number;
  private readonly nodes: AudioScheduledSourceNode[] = [];
  private readonly roundRobinCursor = new Map<string, number>();

  constructor(
    readonly instrumentId: string,
    private readonly context: BaseAudioContext,
    private readonly pack: LoadedPack,
  ) {
    this.releaseTailSec = pack.playback.tailSec ?? Math.max(
      pack.playback.releaseSec,
      ...pack.zones.map((zone) => zone.buffer.duration),
    );
  }

  scheduleNotes(destination: AudioNode, notes: readonly ScheduledNote[], originSec: number): void {
    for (const note of notes) {
      const zone = this.pickZone(note.pitch, note.velocity);
      if (zone) this.play(
        destination, zone, note.pitch, note.velocity, originSec + note.startSec,
        Math.max(0.05, note.endSec - note.startSec),
      );
    }
  }

  scheduleHits(destination: AudioNode, hits: readonly ScheduledHit[], originSec: number): void {
    for (const hit of hits) {
      const drum = hit.drum === 'unknown' ? 'hat' : hit.drum;
      const zone = this.pickZone(drum === 'kick' ? 36 : drum === 'snare' ? 38 : 42, hit.velocity, drum);
      // Played away from the zone's root rather than at it, which is how the
      // sample engine already transposes: the playback rate follows.
      if (zone) {
        this.play(
          destination,
          zone,
          zone.rootMidi + (hit.tuneSemitones ?? 0),
          hit.velocity,
          originSec + hit.startSec,
          null,
        );
      }
    }
  }

  private pickZone(
    pitch: number,
    velocity: number,
    drum?: 'kick' | 'snare' | 'hat',
  ): LoadedZone | undefined {
    const matchingKind = this.pack.zones.filter((zone) => drum ? zone.drum === drum : zone.drum === undefined);
    if (matchingKind.length === 0) return undefined;
    const matchingVelocity = matchingKind.filter((zone) =>
      velocity >= (zone.minVelocity ?? 1) && velocity <= (zone.maxVelocity ?? 127));
    const layered = matchingVelocity.length > 0 ? matchingVelocity : matchingKind;
    const inRange = layered.filter((zone) => pitch >= zone.lowMidi && pitch <= zone.highMidi);
    const candidates = inRange.length > 0 ? inRange : layered.filter((zone) => {
      const nearest = Math.min(...layered.map((item) => Math.abs(item.rootMidi - pitch)));
      return Math.abs(zone.rootMidi - pitch) === nearest;
    });
    if (candidates.length === 0) return undefined;
    const key = `${drum ?? pitch}:${Math.floor(velocity / 16)}`;
    const cursor = this.roundRobinCursor.get(key) ?? 0;
    this.roundRobinCursor.set(key, cursor + 1);
    return candidates[cursor % candidates.length];
  }

  private play(
    destination: AudioNode,
    zone: LoadedZone,
    pitch: number,
    velocity: number,
    startSec: number,
    heldSec: number | null,
  ): void {
    const source = this.context.createBufferSource();
    source.buffer = zone.buffer;
    source.playbackRate.value = 2 ** ((pitch - zone.rootMidi) / 12);
    if (zone.loop) {
      source.loop = true;
      source.loopStart = zone.loop.startSec;
      source.loopEnd = zone.loop.endSec;
    }
    const gain = this.context.createGain();
    const level = (Math.max(1, Math.min(127, velocity)) / 127) ** 1.45;
    gain.gain.setValueAtTime(level, startSec);

    const naturalEnd = startSec + zone.buffer.duration / source.playbackRate.value;
    let stopAt = naturalEnd;
    if (heldSec !== null && this.pack.playback.mode === 'gated') {
      const noteOff = startSec + heldSec;
      stopAt = Math.min(naturalEnd, noteOff + this.pack.playback.releaseSec);
      gain.gain.setValueAtTime(level, noteOff);
      gain.gain.linearRampToValueAtTime(0.0001, stopAt);
    } else if (zone.loop && heldSec !== null) {
      const noteOff = startSec + heldSec;
      stopAt = noteOff + this.pack.playback.releaseSec;
      gain.gain.setValueAtTime(level, noteOff);
      gain.gain.linearRampToValueAtTime(0.0001, stopAt);
    }

    source.connect(gain);
    gain.connect(destination);
    source.start(startSec);
    source.stop(stopAt + 0.01);
    this.nodes.push(source);
  }

  dispose(): void {
    for (const node of this.nodes) {
      try { node.stop(); } catch { /* Already finished. */ }
    }
    this.nodes.length = 0;
  }
}

export class SampleEngine implements SynthEngine {
  readonly id = 'sample';
  constructor(private readonly baseUrl = '/instruments') {}

  supports(instrument: InstrumentDefinition): boolean { return instrument.samplePack !== null; }

  async prepare(
    instrument: InstrumentDefinition,
    context: BaseAudioContext,
    onProgress?: (fraction: number) => void,
  ): Promise<PreparedInstrument> {
    if (instrument.samplePack === null) throw appError('no sample pack');
    const pack = await this.loadPack(instrument, context, onProgress);
    return new SampleInstrument(instrument.id, context, pack);
  }

  private loadPack(
    instrument: InstrumentDefinition,
    context: BaseAudioContext,
    onProgress?: (fraction: number) => void,
  ): Promise<LoadedPack> {
    const packUrl = `${this.baseUrl}/${instrument.samplePack as string}`;
    const cached = packCache.get(packUrl);
    if (cached) {
      onProgress?.(cached.progress);
      if (onProgress && cached.progress < 1) cached.listeners.add(onProgress);
      return cached.promise.finally(() => onProgress && cached.listeners.delete(onProgress));
    }

    const entry: CacheEntry = { progress: 0, listeners: new Set(), promise: Promise.resolve(null as never) };
    if (onProgress) entry.listeners.add(onProgress);
    const report = (fraction: number): void => {
      entry.progress = Math.max(entry.progress, Math.min(1, fraction));
      for (const listener of entry.listeners) listener(entry.progress);
    };

    entry.promise = (async () => {
      const manifestResponse = await fetch(packUrl);
      if (!manifestResponse.ok) throw appError(`manifest ${manifestResponse.status}`);
      const manifest = validateSampleManifest(await manifestResponse.json(), instrument);
      report(0.04);
      const directory = packUrl.slice(0, packUrl.lastIndexOf('/'));
      let finished = 0;
      const zones = await mapWithConcurrency(manifest.zones, 6, async (zone) => {
        const response = await fetch(`${directory}/${zone.file}`);
        if (!response.ok) throw appError(`sample ${response.status}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        finished += 1;
        report(0.04 + (finished / manifest.zones.length) * 0.96);
        return { ...zone, buffer };
      });
      return {
        zones,
        playback: manifest.playback ?? { mode: 'gated', releaseSec: 0.06 },
      };
    })();

    packCache.set(packUrl, entry);
    entry.promise.then(() => report(1)).catch(() => packCache.delete(packUrl)).finally(() => {
      entry.listeners.clear();
    });
    return entry.promise;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[], limit: number, mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

/** Test/dev hook; production retains decoded packs for the tab lifetime. */
export function clearSampleCache(): void { packCache.clear(); }
