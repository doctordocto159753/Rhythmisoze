import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SampleEngine, clearSampleCache, getInstrument } from '@synthesis';

interface TaggedBuffer extends AudioBuffer { tag: number }
interface FakeSource {
  buffer: TaggedBuffer | null;
  playbackRate: { value: number };
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

function audioContext(sources: FakeSource[]) {
  return {
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => {
      const tag = new Uint8Array(bytes)[0] as number;
      return { duration: tag === 1 ? 2 : 3, tag } as TaggedBuffer;
    }),
    createBufferSource: vi.fn(() => {
      const source: FakeSource = {
        buffer: null,
        playbackRate: { value: 1 },
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
      };
      sources.push(source);
      return source;
    }),
    createGain: vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    })),
  } as unknown as BaseAudioContext;
}

function manifestResponse(manifest: unknown, files: Record<string, number>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
    const entry = Object.entries(files).find(([suffix]) => url.endsWith(suffix));
    return entry ? new Response(new Uint8Array([entry[1]])) : new Response(null, { status: 404 });
  });
}

describe('sample scheduling', () => {
  beforeEach(() => clearSampleCache());
  afterEach(() => vi.unstubAllGlobals());

  it('selects acoustic drum velocity layers and lets hits decay naturally', async () => {
    const instrument = getInstrument('acoustic-kit');
    if (!instrument) throw new Error('acoustic kit fixture missing');
    const manifest = {
      version: 2, id: 'live-room-kit', name: 'Live Room Kit', type: 'sample',
      license: { ...instrument.license },
      playback: { mode: 'natural', releaseSec: 0.18, tailSec: 3 },
      samples: { soft: 'samples/soft.wav', hard: 'samples/hard.wav' },
      zones: [
        { file: 'samples/soft.wav', rootMidi: 36, lowMidi: 35, highMidi: 36,
          drum: 'kick', minVelocity: 1, maxVelocity: 80 },
        { file: 'samples/hard.wav', rootMidi: 36, lowMidi: 35, highMidi: 36,
          drum: 'kick', minVelocity: 81, maxVelocity: 127 },
      ],
    };
    vi.stubGlobal('fetch', manifestResponse(manifest, { 'soft.wav': 1, 'hard.wav': 2 }));
    const sources: FakeSource[] = [];
    const context = audioContext(sources);
    const prepared = await new SampleEngine('/packs').prepare(instrument, context);
    prepared.scheduleHits({} as AudioNode, [
      { drum: 'kick', velocity: 40, startSec: 0 },
      { drum: 'kick', velocity: 120, startSec: 0.5 },
    ], 0);

    expect(sources.map((source) => source.buffer?.tag)).toEqual([1, 2]);
    expect(sources[0]?.stop).toHaveBeenCalledWith(2.01);
    expect(sources[1]?.stop).toHaveBeenCalledWith(3.51);
  });

  it('applies a manifest-defined release to gated sustained instruments', async () => {
    const instrument = getInstrument('violin');
    if (!instrument) throw new Error('violin fixture missing');
    const manifest = {
      version: 2, id: 'tender-violin', name: 'Tender Violin', type: 'sample',
      license: { ...instrument.license },
      playback: { mode: 'gated', releaseSec: 0.2, tailSec: 0.2 },
      samples: { C4: 'samples/C4.mp3' },
      zones: [{ file: 'samples/C4.mp3', rootMidi: 60, lowMidi: 60, highMidi: 60 }],
    };
    vi.stubGlobal('fetch', manifestResponse(manifest, { 'C4.mp3': 2 }));
    const sources: FakeSource[] = [];
    const context = audioContext(sources);
    const prepared = await new SampleEngine('/packs').prepare(instrument, context);
    prepared.scheduleNotes({} as AudioNode, [
      { pitch: 60, velocity: 100, startSec: 0, endSec: 0.5 },
    ], 0);

    expect(sources[0]?.stop).toHaveBeenCalledWith(0.71);
  });
});
