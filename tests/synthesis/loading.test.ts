import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SampleEngine,
  clearSampleCache,
  getInstrument,
  preloadInstrument,
  validateSampleManifest,
} from '@synthesis';

const piano = getInstrument('piano');
if (!piano) throw new Error('piano fixture missing');

const manifest = {
  version: 2,
  id: 'warm-grand',
  name: 'Warm Grand',
  type: 'sample',
  license: {
    spdx: piano.license.spdx,
    source: piano.license.source,
    url: piano.license.url,
    attributionRequired: true,
    redistribution: true,
  },
  playback: { mode: 'natural', releaseSec: 0.4, tailSec: 1 },
  samples: { C4: 'samples/C4.mp3' },
  zones: [{
    file: 'samples/C4.mp3', rootMidi: 60, lowMidi: 60, highMidi: 60,
    minVelocity: 1, maxVelocity: 127,
  }],
} as const;

function decodingContext() {
  return {
    sampleRate: 44_100,
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer)),
    decodeAudioData: vi.fn(async () => ({ duration: 1 } as AudioBuffer)),
  } as unknown as BaseAudioContext;
}

describe('sample loading and cache', () => {
  beforeEach(() => clearSampleCache());
  afterEach(() => vi.unstubAllGlobals());

  it('does not fetch merely because the engine or registry is imported', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const engine = new SampleEngine('/packs');
    expect(engine.supports(piano)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads asynchronously, reports determinate progress and reuses decoded buffers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('manifest.json')
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const context = decodingContext();
    const progress: number[] = [];
    const engine = new SampleEngine('/packs');

    const first = await engine.prepare(piano, context, (fraction) => progress.push(fraction));
    const second = await engine.prepare(piano, context);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)).toBe(1);
    expect(progress.some((value) => value > 0 && value < 1)).toBe(true);
    expect(first.engineId).toBe('sample');
    expect(second.engineId).toBe('sample');
  });

  it('rejects traversal paths before fetching a sample', () => {
    const bad = { ...manifest, zones: [{ ...manifest.zones[0], file: '../secret.wav' }] };
    expect(() => validateSampleManifest(bad, piano)).toThrow(/unsafe sample path/i);
  });

  it('falls back to the procedural voice when a sample pack is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const result = await preloadInstrument(decodingContext(), piano.id);
    expect(result).toEqual({ engineId: 'procedural', fellBack: true });
  });
});
