import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Midi } from '@tonejs/midi';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TRANSCRIPTION_ENABLED;
  delete process.env.TRANSCRIPTION_API_URL;
});

describe('GAME-first production reachability', () => {
  it('keeps the browser client thin and makes no old-worker fallback reachable', () => {
    const client = readFileSync(
      join(process.cwd(), 'src/features/transcription/client.ts'),
      'utf8',
    );
    const flow = readFileSync(
      join(process.cwd(), 'src/features/creation/useCreationFlow.ts'),
      'utf8',
    );
    expect(client).not.toMatch(/new Worker|basic-pitch|transcription\.worker|pitch-tracker|witness/i);
    expect(flow).not.toMatch(/transcription\.worker|witnessAvailability|WITNESS_URL|importMidi\(/);
    expect(client).toContain("fetch('/api/transcription/transcribe'");
    expect(flow).toContain('importMidiOnServer');
  });

  it('parses MIDI on the server without invoking GAME or any external fetch', async () => {
    const externalFetch = vi.fn(() => {
      throw new Error('MIDI must not invoke an audio transcriber');
    });
    vi.stubGlobal('fetch', externalFetch);
    const midi = new Midi();
    midi.header.setTempo(111);
    midi.addTrack().addNote({ midi: 67, time: 0.25, duration: 0.75, velocity: 0.6 });
    const form = new FormData();
    const bytes = midi.toArray();
    form.append('midi', new Blob([bytes.buffer as ArrayBuffer]), 'source.mid');
    const request = new Request('http://localhost/api/transcription/midi', {
      method: 'POST',
      body: form,
    });
    const { POST } = await import('@/app/api/transcription/midi/route');
    const response = await POST(request as never);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.rawTranscription.provenance.transcriber).toBe('midi-import');
    expect(payload.rawTranscription.notes[0]).toMatchObject({
      pitchMidi: 67,
      sourceTrack: 1,
      sourceChannel: 0,
    });
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it('surfaces GAME unavailability as 503 and never manufactures fallback notes', async () => {
    process.env.TRANSCRIPTION_ENABLED = 'true';
    process.env.TRANSCRIPTION_API_URL = 'http://transcription:8083';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'no model.pt under /models/game' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )));
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array([1, 2, 3]).buffer]), 'take.wav');
    form.append('mode', 'voice');
    const request = new Request('http://localhost/api/transcription/transcribe', {
      method: 'POST', body: form,
    });
    const { POST } = await import('@/app/api/transcription/transcribe/route');
    const response = await POST(request as never);
    const payload = await response.json();
    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: 'transcription_unavailable',
      detail: 'no model.pt under /models/game',
    });
    expect(payload.notes).toBeUndefined();
  });
});
