/**
 * The one route in this application that accepts a recording.
 *
 * Everything asserted here is about the two things that make it different from
 * every other endpoint: it must refuse to exist unless an operator switched it
 * on, and it must never turn the service's output into evidence without
 * checking it first.
 *
 * The failure cases matter more than the success case. A witness that cannot
 * answer is not an error the user should ever see — the arbitration needs two
 * agreeing engines, so "no answer" and "answered and agreed" end at the same
 * transcription — so the route collapses every failure to one silent shape, and
 * these tests pin that it really is every failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function route() {
  // Imported per-test: the config is read at call time but the module graph
  // caches, and a stale import would read another case's environment.
  vi.resetModules();
  return import('@/app/api/transcription/witness/route');
}

function upload(bytes = 1024): FormData {
  const body = new FormData();
  body.append('audio', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'take.wav');
  return body;
}

function request(body: BodyInit | null): Request {
  return new Request('http://localhost/api/transcription/witness', { method: 'POST', body });
}

function enable(): void {
  process.env.TRANSCRIPTION_ENABLED = 'true';
  process.env.TRANSCRIPTION_API_URL = 'http://transcription:8083';
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TRANSCRIPTION_ENABLED;
  delete process.env.TRANSCRIPTION_API_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('when the operator has not switched it on', () => {
  it('accepts nothing, and does not call anything', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { POST } = await route();

    const response = await POST(request(upload()) as never);
    expect(response.status).toBe(204);
    // The important half: a disabled deployment must not forward audio
    // anywhere, not merely decline to report what came back.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is disabled by a flag alone, with no URL configured', async () => {
    process.env.TRANSCRIPTION_ENABLED = 'true';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { POST } = await route();

    // A deployment that sets the flag and forgets the address must not send
    // audio to a relative path that resolves back to this app.
    expect((await POST(request(upload()) as never)).status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('when it is switched on', () => {
  it('rejects a request with no audio in it', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn());
    const { POST } = await route();
    const response = await POST(request(new FormData()) as never);
    expect(response.status).toBe(400);
  });

  it('refuses an upload larger than a minute of audio could be', async () => {
    enable();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { POST } = await route();

    const response = await POST(request(upload(17 * 1024 * 1024)) as never);
    expect(response.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the notes when the service answers', async () => {
    enable();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          engine: 'game',
          notes: [{ startSec: 0.2, endSec: 0.8, pitch: 60.4 }],
        }),
      ),
    );
    const { POST } = await route();

    const response = await POST(request(upload()) as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { engine: string; notes: unknown[] };
    expect(body.engine).toBe('game');
    expect(body.notes).toEqual([{ startSec: 0.2, endSec: 0.8, pitch: 60.4 }]);
  });

  it('keeps an empty answer, because it is one', async () => {
    enable();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ engine: 'game', notes: [] })));
    const { POST } = await route();

    // "The engine listened and heard nothing" is evidence. Collapsing it into
    // the same 204 as "the engine did not answer" would launder a measurement
    // into an absence.
    const response = await POST(request(upload()) as never);
    expect(response.status).toBe(200);
    expect((await response.json()).notes).toEqual([]);
  });

  it('drops rows that are not notes rather than passing them on', async () => {
    enable();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          notes: [
            { startSec: 0.1, endSec: 0.5, pitch: 60 },
            { startSec: 1, endSec: 0.5, pitch: 60 },          // ends before it starts
            { startSec: 2, endSec: 2.5, pitch: Number.NaN },  // not a number
            { startSec: 3, endSec: 3.5, pitch: 999 },         // not a MIDI pitch
            { startSec: -1, endSec: 1, pitch: 60 },           // before the recording
            'nonsense',
          ],
        }),
      ),
    );
    const { POST } = await route();

    // The service is trusted infrastructure, not trusted input: it drives a
    // research model through a CLI, and a malformed row reaching the
    // arbitration as a NaN pitch would be a silent wrong answer.
    const body = (await (await POST(request(upload()) as never)).json()) as { notes: unknown[] };
    expect(body.notes).toEqual([{ startSec: 0.1, endSec: 0.5, pitch: 60 }]);
  });

  it.each([
    ['a 502 from the service', async () => new Response(null, { status: 502 })],
    ['a 503 when the weights are missing', async () => new Response(null, { status: 503 })],
    ['a connection failure', async () => { throw new Error('ECONNREFUSED'); }],
    ['a reply that is not JSON', async () => new Response('<html>', { status: 200 })],
    ['a reply with no notes field', async () => Response.json({ engine: 'game' })],
  ])('reports no opinion for %s', async (_label, impl) => {
    enable();
    vi.stubGlobal('fetch', vi.fn(impl));
    const { POST } = await route();

    const response = await POST(request(upload()) as never);
    expect(response.status).toBe(204);
  });
});
