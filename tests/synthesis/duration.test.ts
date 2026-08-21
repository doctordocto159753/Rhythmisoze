/**
 * Source duration versus musical duration.
 *
 * ## The bug these exist for
 *
 * A sketch has two lengths that used to share one variable: how long the person
 * hummed, and how long the version they are listening to runs. For the Judge and
 * the Teacher those are near enough the same number. For the Musician they are
 * not — Expanded is explicitly allowed to grow the idea.
 *
 * From a real take: a 10.14 s recording came back as a 38.74 s Expanded passage.
 * Playback and the offline render were both sized from the recording, so the
 * exported WAV was 12.14 s — 10.14 s of music plus the release tail — and the
 * last twenty-six seconds of the piece simply were not in the file. Nothing
 * errored. The file was just short.
 *
 * The fix is two concepts rather than one changed number: the recording's length
 * still means the recording's length (the Judge, the Teacher and the Identity
 * Guard all measure against it), and what is played and rendered is derived from
 * the notes that will actually be scheduled.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DrumEvent, NoteEvent } from '@contracts';
import { musicalDurationSec, renderSketch } from '@synthesis';

/** The real take these numbers come from. */
const SOURCE_DURATION_SEC = 10.14;
const EXPANDED_LAST_NOTE_END_SEC = 38.74;

function note(startSec: number, endSec: number, pitch = 64): NoteEvent {
  return { startSec, endSec, pitch, velocity: 92 };
}

/** An Expanded passage: it starts inside the recording and runs well past it. */
function expandedNotes(): NoteEvent[] {
  const notes: NoteEvent[] = [];
  const step = EXPANDED_LAST_NOTE_END_SEC / 58;
  for (let index = 0; index < 58; index += 1) {
    const startSec = index * step;
    notes.push(note(startSec, startSec + step * 0.9, 60 + (index % 8)));
  }
  // Pin the last note exactly where the real one ended.
  notes[notes.length - 1] = note(EXPANDED_LAST_NOTE_END_SEC - 0.6, EXPANDED_LAST_NOTE_END_SEC, 72);
  return notes;
}

/** A normal version: thirteen notes, all comfortably inside the recording. */
function judgeNotes(): NoteEvent[] {
  return Array.from({ length: 13 }, (_, index) =>
    note(index * 0.62, index * 0.62 + 0.45, 60 + (index % 5)),
  );
}

describe('musicalDurationSec', () => {
  it('reaches the end of a version that outgrew its recording', () => {
    const span = musicalDurationSec(expandedNotes(), [], SOURCE_DURATION_SEC);
    expect(span).toBeCloseTo(EXPANDED_LAST_NOTE_END_SEC, 6);
    expect(span).toBeGreaterThan(SOURCE_DURATION_SEC);
  });

  it('keeps the recording as a floor for an ordinary short version', () => {
    // Test C: a take with silence after the last note still plays its full
    // length, which is what every derived version already did.
    const notes = judgeNotes();
    const lastEnd = notes[notes.length - 1]?.endSec ?? 0;
    expect(lastEnd).toBeLessThan(SOURCE_DURATION_SEC);
    expect(musicalDurationSec(notes, [], SOURCE_DURATION_SEC)).toBe(SOURCE_DURATION_SEC);
  });

  it('counts drum hits, which have an onset and no length', () => {
    const drums: DrumEvent[] = [
      { timeSec: 1, drum: 'kick', velocity: 100, confidence: 1 },
      { timeSec: 14.5, drum: 'snare', velocity: 90, confidence: 1 },
    ];
    expect(musicalDurationSec([], drums, 4)).toBe(14.5);
  });

  it('is the recording alone when there is nothing to play', () => {
    expect(musicalDurationSec([], [], SOURCE_DURATION_SEC)).toBe(SOURCE_DURATION_SEC);
  });

  it('ignores a floor that is missing or nonsense rather than propagating it', () => {
    expect(musicalDurationSec(judgeNotes(), [])).toBeCloseTo(7.89, 2);
    expect(musicalDurationSec(judgeNotes(), [], Number.NaN)).toBeCloseTo(7.89, 2);
    expect(musicalDurationSec([], [], -5)).toBe(0);
  });
});

/**
 * A fake offline context.
 *
 * Only what the master bus and the procedural engine actually touch. It exists
 * to record the buffer length the renderer asks for, which is the number the bug
 * was in — a buffer sized below the last scheduled event produces a file that is
 * quietly missing the end of the piece.
 */
function fakeOfflineContext(record: { length: number; sampleRate: number }) {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  const node = (extra: Record<string, unknown> = {}) => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    ...extra,
  });

  return class FakeOfflineAudioContext {
    readonly destination = node();
    readonly sampleRate: number;
    readonly length: number;

    constructor(_channels: number, length: number, sampleRate: number) {
      this.length = length;
      this.sampleRate = sampleRate;
      record.length = length;
      record.sampleRate = sampleRate;
    }

    createBuffer(channels: number, length: number, sampleRate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (channel: number) => data[channel] as Float32Array,
        copyToChannel: vi.fn(),
      };
    }

    createGain() {
      return node({ gain: param() });
    }

    createOscillator() {
      return node({ frequency: param(), detune: param(), type: 'sine' });
    }

    createBiquadFilter() {
      return node({ frequency: param(), Q: param(), gain: param(), type: 'lowpass' });
    }

    createBufferSource() {
      return node({ buffer: null, playbackRate: param(), loop: false });
    }

    createConvolver() {
      return node({ buffer: null, normalize: true });
    }

    createDynamicsCompressor() {
      return node({
        threshold: param(),
        knee: param(),
        ratio: param(),
        attack: param(),
        release: param(),
      });
    }

    async startRendering() {
      return this.createBuffer(2, this.length, this.sampleRate);
    }
  };
}

async function renderWith(request: {
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  durationSec: number;
}): Promise<{ bufferSeconds: number }> {
  const record = { length: 0, sampleRate: 0 };
  const original = globalThis.OfflineAudioContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).OfflineAudioContext = fakeOfflineContext(record);
  try {
    const result = await renderSketch({
      // Rendered with the procedural engine (`quality: 'synth'`), so no network
      // request and no sample pack are involved.
      instrumentId: 'flute',
      notes: request.notes,
      drums: request.drums,
      durationSec: request.durationSec,
      quality: 'synth',
    });
    return { bufferSeconds: result.buffer.length / result.buffer.sampleRate };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).OfflineAudioContext = original;
  }
}

describe('the offline render', () => {
  it('contains the whole of a version that outgrew its recording', async () => {
    const notes = expandedNotes();
    const { bufferSeconds } = await renderWith({
      notes,
      drums: [],
      durationSec: musicalDurationSec(notes, [], SOURCE_DURATION_SEC),
    });

    // The failing assertion before the fix: the buffer was 10.14 + tail = 12.14 s.
    expect(bufferSeconds).toBeGreaterThan(EXPANDED_LAST_NOTE_END_SEC);
    expect(bufferSeconds).toBeGreaterThan(14);
    // The tail comes *after* the music rather than being baked into its length.
    expect(bufferSeconds - EXPANDED_LAST_NOTE_END_SEC).toBeGreaterThanOrEqual(2);
    expect(bufferSeconds - EXPANDED_LAST_NOTE_END_SEC).toBeLessThan(5);
  });

  it('never renders less music than it was handed, whatever it was told', async () => {
    // An invariant rather than a fallback. A caller that passes the recording's
    // length by mistake gets a complete file rather than a silently short one.
    const notes = expandedNotes();
    const { bufferSeconds } = await renderWith({
      notes,
      drums: [],
      durationSec: SOURCE_DURATION_SEC,
    });
    expect(bufferSeconds).toBeGreaterThan(EXPANDED_LAST_NOTE_END_SEC);
  });

  it('still renders an ordinary version at the length it was asked for', async () => {
    // Test C: nothing about the short case changes.
    const notes = judgeNotes();
    const { bufferSeconds } = await renderWith({
      notes,
      drums: [],
      durationSec: musicalDurationSec(notes, [], SOURCE_DURATION_SEC),
    });
    expect(bufferSeconds).toBeGreaterThanOrEqual(SOURCE_DURATION_SEC + 2);
    expect(bufferSeconds).toBeLessThan(SOURCE_DURATION_SEC + 5);
  });

  it('reports its speed against the music it actually rendered', async () => {
    // Measuring a 38.74 s render against a 10.14 s clip would flatter the
    // performance budget by nearly four times.
    const record = { length: 0, sampleRate: 0 };
    const original = globalThis.OfflineAudioContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).OfflineAudioContext = fakeOfflineContext(record);
    try {
      const notes = expandedNotes();
      const long = await renderSketch({
        instrumentId: 'flute',
        notes,
        drums: [],
        durationSec: SOURCE_DURATION_SEC,
        quality: 'synth',
      });
      expect(long.realtimeRatio).toBeCloseTo(long.elapsedMs / 1000 / EXPANDED_LAST_NOTE_END_SEC, 6);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).OfflineAudioContext = original;
    }
  });
});
