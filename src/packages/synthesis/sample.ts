/**
 * The sample-playback engine.
 *
 * This is the path to the "realistic / acoustic" instrument direction the
 * product owner chose (questionnaire Q-D4). The mechanism is complete and
 * tested; what it is waiting on is licensed audio. No instrument in the registry
 * declares a `samplePack` yet, so this engine currently reports `supports()` as
 * false for all of them and the procedural engine handles everything - see
 * ADR-002 and `docs/licenses/instruments.md`.
 *
 * ## Manifest format
 *
 * `public/instruments/<id>/manifest.json`:
 *
 * ```json
 * {
 *   "version": 1,
 *   "license": { "spdx": "CC0-1.0", "source": "...", "url": "..." },
 *   "loopDefault": false,
 *   "zones": [
 *     { "file": "c3.opus", "rootMidi": 48, "lowMidi": 43, "highMidi": 53, "loop": null }
 *   ]
 * }
 * ```
 *
 * A zone is stretched by playback rate to cover its range. Recording every
 * semitone would sound better and cost far more to download; multisampling in
 * roughly a fifth is the usual compromise and is what the manifest assumes.
 *
 * ## Why this satisfies lazy loading (US-0603)
 *
 * Nothing is fetched until `prepare` is called for a specific instrument, the
 * decoded buffers are cached per instrument, and progress is reported per file
 * so the gallery can show a real bar rather than a spinner.
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
  /** Drum class this zone voices, for percussion packs. */
  drum?: 'kick' | 'snare' | 'hat';
  loop?: { startSec: number; endSec: number } | null;
}

export interface SampleManifest {
  version: number;
  license: { spdx: string; source: string; url?: string };
  zones: SampleZone[];
}

interface LoadedZone extends SampleZone {
  buffer: AudioBuffer;
}

/** Decoded packs, keyed by instrument id, shared across prepares. */
const packCache = new Map<string, Promise<LoadedZone[]>>();

class SampleInstrument implements PreparedInstrument {
  readonly engineId = 'sample';
  readonly releaseTailSec = 0.6;

  private readonly nodes: AudioScheduledSourceNode[] = [];

  constructor(
    readonly instrumentId: string,
    private readonly context: BaseAudioContext,
    private readonly zones: readonly LoadedZone[],
  ) {}

  scheduleNotes(destination: AudioNode, notes: readonly ScheduledNote[], originSec: number): void {
    for (const note of notes) {
      const zone = this.pickZone(note.pitch);
      if (!zone) continue;
      this.play(destination, zone, note.pitch, note.velocity, originSec + note.startSec,
        Math.max(0.05, note.endSec - note.startSec));
    }
  }

  scheduleHits(destination: AudioNode, hits: readonly ScheduledHit[], originSec: number): void {
    for (const hit of hits) {
      const drum = hit.drum === 'unknown' ? 'hat' : hit.drum;
      const zone = this.zones.find((z) => z.drum === drum);
      if (!zone) continue;
      // Percussion samples play to their natural end rather than being gated.
      this.play(destination, zone, zone.rootMidi, hit.velocity, originSec + hit.startSec, null);
    }
  }

  private pickZone(pitch: number): LoadedZone | undefined {
    const inRange = this.zones.find((zone) => pitch >= zone.lowMidi && pitch <= zone.highMidi);
    if (inRange) return inRange;
    // Outside every zone: stretch the nearest root rather than going silent.
    return this.zones.reduce<LoadedZone | undefined>((best, zone) => {
      if (!best) return zone;
      return Math.abs(zone.rootMidi - pitch) < Math.abs(best.rootMidi - pitch) ? zone : best;
    }, undefined);
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
    const level = (Math.max(1, Math.min(127, velocity)) / 127) ** 1.6;
    gain.gain.setValueAtTime(level, startSec);

    const naturalEnd = startSec + zone.buffer.duration / source.playbackRate.value;
    const stopAt = heldSec === null ? naturalEnd : startSec + heldSec;
    if (heldSec !== null) {
      // 60 ms release so a gated sample does not click on note-off.
      gain.gain.setValueAtTime(level, Math.max(startSec, stopAt - 0.06));
      gain.gain.linearRampToValueAtTime(0.0001, stopAt);
    }

    source.connect(gain);
    gain.connect(destination);
    source.start(startSec);
    source.stop(stopAt + 0.05);
    this.nodes.push(source);
  }

  dispose(): void {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Already finished.
      }
    }
    this.nodes.length = 0;
  }
}

export class SampleEngine implements SynthEngine {
  readonly id = 'sample';

  constructor(private readonly baseUrl = '/instruments') {}

  supports(instrument: InstrumentDefinition): boolean {
    return instrument.samplePack !== null;
  }

  async prepare(
    instrument: InstrumentDefinition,
    context: BaseAudioContext,
    onProgress?: (fraction: number) => void,
  ): Promise<PreparedInstrument> {
    if (instrument.samplePack === null) {
      throw new AppError('instrument_load_failed', 'choose_other_instrument', 'no sample pack');
    }
    const zones = await this.loadPack(instrument, context, onProgress);
    return new SampleInstrument(instrument.id, context, zones);
  }

  private loadPack(
    instrument: InstrumentDefinition,
    context: BaseAudioContext,
    onProgress?: (fraction: number) => void,
  ): Promise<LoadedZone[]> {
    const cached = packCache.get(instrument.id);
    if (cached) {
      onProgress?.(1);
      return cached;
    }

    const promise = (async (): Promise<LoadedZone[]> => {
      const packUrl = `${this.baseUrl}/${instrument.samplePack as string}`;
      const manifestResponse = await fetch(packUrl);
      if (!manifestResponse.ok) {
        throw new AppError(
          'instrument_load_failed',
          'choose_other_instrument',
          `manifest ${manifestResponse.status}`,
        );
      }
      const manifest = (await manifestResponse.json()) as SampleManifest;
      const directory = packUrl.slice(0, packUrl.lastIndexOf('/'));

      const loaded: LoadedZone[] = [];
      for (let i = 0; i < manifest.zones.length; i += 1) {
        const zone = manifest.zones[i] as SampleZone;
        const response = await fetch(`${directory}/${zone.file}`);
        if (!response.ok) {
          throw new AppError(
            'instrument_load_failed',
            'choose_other_instrument',
            `sample ${response.status}`,
          );
        }
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        loaded.push({ ...zone, buffer });
        onProgress?.((i + 1) / manifest.zones.length);
      }
      return loaded;
    })();

    packCache.set(instrument.id, promise);
    // A failed load must not poison the cache for the next attempt.
    promise.catch(() => packCache.delete(instrument.id));
    return promise;
  }
}
