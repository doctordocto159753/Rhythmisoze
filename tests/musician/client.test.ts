import { describe, expect, it, vi } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  MusicianClient,
  MusicianError,
  musicianResultSchema,
  noteSchema,
  toAppError,
  type MusicianRequest,
} from '@musician-client';

/**
 * The network boundary, tested from the outside in.
 *
 * The cases that matter are the malformed ones. A client that handles a correct
 * response is table stakes; the reason this file exists is that the response
 * comes from a service running generative models, and its interesting failure is
 * not "the field is missing" but "the field is there and is nonsense".
 */

function note(pitch: number, start: number): NoteEvent {
  return { pitch, startSec: start, endSec: start + 0.4, velocity: 90 };
}

const request: MusicianRequest = {
  sourceId: 'sketch-1',
  notes: [note(60, 0), note(62, 0.5), note(64, 1)],
  phrases: [{ startIndex: 0, endIndex: 2 }],
  bpm: 120,
  tempoConfidence: 0.8,
  meter: { numerator: 4, denominator: 4, confidence: 0.8 },
  key: { tonic: 'C', mode: 'major', confidence: 0.7 },
  durationSec: 2,
};

function variant(kind: 'refined' | 'developed' | 'expanded') {
  return {
    kind,
    notes: [
      { pitch: 60, start_sec: 0, end_sec: 0.4, velocity: 90 },
      { pitch: 64, start_sec: 0.5, end_sec: 0.9, velocity: 90 },
    ],
    tempo: { bpm: 120, confidence: 0.8 },
    meter: { numerator: 4, denominator: 4, confidence: 0.8 },
    key: { tonic: 'C', mode: 'major', confidence: 0.7 },
    duration_sec: 1,
    identity: {
      contour_similarity: 0.9,
      motif_survival: 0.8,
      phrase_similarity: 0.9,
      tonal_compatibility: 1,
      meter_compatibility: 1,
      duration_ratio: 1,
      pitch_range_change: 1,
      note_density_change: 1,
      aggregate: 0.88,
      passed: true,
      failures: [],
    },
    infill_spans: [],
  };
}

const validResult = {
  version: 1 as const,
  source_id: 'sketch-1',
  refined: variant('refined'),
  developed: variant('developed'),
  expanded: variant('expanded'),
  provenance: {
    melody_t5_revision: 'rev-a',
    midi_rwkv_revision: 'rev-b',
    musician_service_version: '0.1.0',
    input_fingerprint: 'abc',
    seeds: { base: 42 },
    parameters: { refined: { candidate_count: 4 } },
    elapsed_ms: 1234,
  },
  diagnostics: {
    candidate_counts: { refined: 4, developed: 4 },
    rejected_candidates: [],
    identity_guard_summary: { rejection_rate: 0 },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch) {
  return new MusicianClient({ fetchImpl, pollIntervalMs: 1, timeoutMs: 5_000 });
}

describe('response validation', () => {
  it('accepts a well-formed result', () => {
    expect(musicianResultSchema.safeParse(validResult).success).toBe(true);
  });

  it('rejects a pitch outside the MIDI range', () => {
    // The exact failure a generative model produces: structurally valid,
    // musically impossible.
    expect(noteSchema.safeParse({ pitch: 4096, start_sec: 0, end_sec: 1, velocity: 90 }).success).toBe(
      false,
    );
    expect(noteSchema.safeParse({ pitch: -1, start_sec: 0, end_sec: 1, velocity: 90 }).success).toBe(
      false,
    );
  });

  it('rejects a note that ends before it starts', () => {
    expect(
      noteSchema.safeParse({ pitch: 60, start_sec: 2, end_sec: 1, velocity: 90 }).success,
    ).toBe(false);
  });

  it('rejects a zero velocity', () => {
    expect(
      noteSchema.safeParse({ pitch: 60, start_sec: 0, end_sec: 1, velocity: 0 }).success,
    ).toBe(false);
  });

  it('rejects a variant with no notes', () => {
    // A version with nothing in it must never reach the picker.
    const empty = { ...validResult, refined: { ...variant('refined'), notes: [] } };
    expect(musicianResultSchema.safeParse(empty).success).toBe(false);
  });

  it('rejects a result missing a whole variant', () => {
    const { developed: _developed, ...partial } = validResult;
    expect(musicianResultSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects a result missing the expanded variant', () => {
    // A service that has not been updated for the sixth version must be
    // refused rather than silently producing five.
    const { expanded: _expanded, ...partial } = validResult;
    expect(musicianResultSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects an impossible tempo', () => {
    const absurd = {
      ...validResult,
      refined: { ...variant('refined'), tempo: { bpm: 100_000, confidence: 1 } },
    };
    expect(musicianResultSchema.safeParse(absurd).success).toBe(false);
  });
});

describe('the client', () => {
  it('sends note data and never anything binary', async () => {
    // AC-03. Asserted on the wire rather than trusted to the type, because the
    // type is the thing a future change would edit.
    let sent: unknown = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? '{}'));
      return json({ jobId: 'a'.repeat(32), state: 'pending' }, 202);
    }) as unknown as typeof fetch;

    await client(fetchImpl).submit(request);

    const body = sent as { teacher: Record<string, unknown> };
    expect(Object.keys(body.teacher).sort()).toEqual([
      'durationSec',
      'key',
      'meter',
      'notes',
      'phrases',
      'sourceId',
      'tempo',
    ]);
    expect(body.teacher.phrases).toEqual([{ startIndex: 0, endIndex: 2 }]);
    const serialised = JSON.stringify(sent);
    for (const forbidden of ['blob', 'audio', 'wav', 'pcm', 'recording', 'base64']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('never talks to anything but the app origin', async () => {
    // §15: the service URL must not be reachable from the browser.
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return json({ jobId: 'a'.repeat(32), state: 'pending' }, 202);
    }) as unknown as typeof fetch;

    await client(fetchImpl).submit(request);
    expect(urls).toEqual(['/api/musician/jobs']);
  });

  it('returns a result once the job succeeds', async () => {
    const responses = [
      json({ jobId: 'b'.repeat(32), state: 'pending' }, 202),
      json({ jobId: 'b'.repeat(32), state: 'running' }),
      json({ jobId: 'b'.repeat(32), state: 'succeeded', result: validResult }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;

    const result = await client(fetchImpl).generate(request);
    expect(result.refined.notes).toHaveLength(2);
    expect(result.provenance.seeds.base).toBe(42);
  });

  it('reports the phases a person can see', async () => {
    const responses = [
      json({ jobId: 'c'.repeat(32), state: 'pending' }, 202),
      json({ jobId: 'c'.repeat(32), state: 'pending' }),
      json({ jobId: 'c'.repeat(32), state: 'running' }),
      json({ jobId: 'c'.repeat(32), state: 'succeeded', result: validResult }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;

    const phases: string[] = [];
    await client(fetchImpl).generate(request, { onPhase: (phase) => phases.push(phase) });
    expect(phases).toContain('queued');
    expect(phases).toContain('generating_global');
  });

  describe('failures', () => {
    it('classifies an unreachable service as unavailable', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;

      await expect(client(fetchImpl).submit(request)).rejects.toMatchObject({
        kind: 'unavailable',
      });
    });

    it('classifies a 503 as unavailable rather than a crash', async () => {
      const fetchImpl = vi.fn(async () => json({ error: 'musician_disabled' }, 503)) as unknown as typeof fetch;
      await expect(client(fetchImpl).submit(request)).rejects.toMatchObject({
        kind: 'unavailable',
      });
    });

    it('classifies a refused payload as rejected, not retryable-transient', async () => {
      // Retrying the same input will fail the same way, so this is a different
      // kind from a transient outage and the UI treats it differently.
      const fetchImpl = vi.fn(async () => json({ detail: 'no meter' }, 422)) as unknown as typeof fetch;
      await expect(client(fetchImpl).submit(request)).rejects.toMatchObject({ kind: 'rejected' });
    });

    it('rejects a malformed result instead of passing it through', async () => {
      const responses = [
        json({ jobId: 'd'.repeat(32), state: 'pending' }, 202),
        json({
          jobId: 'd'.repeat(32),
          state: 'succeeded',
          result: { ...validResult, refined: { ...variant('refined'), notes: [{ pitch: 999 }] } },
        }),
      ];
      const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;

      await expect(client(fetchImpl).generate(request)).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    });

    it('treats a body that is not JSON as an unusable reply', async () => {
      const responses = [
        json({ jobId: 'e'.repeat(32), state: 'pending' }, 202),
        new Response('<html>gateway error</html>', { status: 200 }),
      ];
      const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
      await expect(client(fetchImpl).generate(request)).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    });

    it('reports a failed job without inventing a result', async () => {
      const responses = [
        json({ jobId: 'f'.repeat(32), state: 'pending' }, 202),
        json({ jobId: 'f'.repeat(32), state: 'failed', error: 'ModelNotLoaded: weights missing' }),
      ];
      const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
      await expect(client(fetchImpl).generate(request)).rejects.toMatchObject({
        kind: 'unavailable',
      });
    });

    it('gives up rather than polling forever', async () => {
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') return json({ jobId: '0'.repeat(32), state: 'pending' }, 202);
        if (init?.method === 'DELETE') return json({});
        return json({ jobId: '0'.repeat(32), state: 'running' });
      }) as unknown as typeof fetch;

      const impatient = new MusicianClient({ fetchImpl, pollIntervalMs: 1, timeoutMs: 30 });
      await expect(impatient.generate(request)).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('cancels the job on the server when it times out', async () => {
      // Otherwise a model keeps working on something nobody will ever read.
      const methods: string[] = [];
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'POST') return json({ jobId: '1'.repeat(32), state: 'pending' }, 202);
        if (init?.method === 'DELETE') return json({});
        return json({ jobId: '1'.repeat(32), state: 'running' });
      }) as unknown as typeof fetch;

      const impatient = new MusicianClient({ fetchImpl, pollIntervalMs: 1, timeoutMs: 20 });
      await expect(impatient.generate(request)).rejects.toThrow();
      expect(methods).toContain('DELETE');
    });

    it('reports a cancelled job as cancelled, not as a failure', async () => {
      const responses = [
        json({ jobId: '2'.repeat(32), state: 'pending' }, 202),
        json({ jobId: '2'.repeat(32), state: 'cancelled' }),
      ];
      const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
      await expect(client(fetchImpl).generate(request)).rejects.toMatchObject({
        kind: 'cancelled',
      });
    });

    it('treats a forgotten job as recoverable', async () => {
      // The service restarted with an ephemeral queue. Starting again works,
      // so this is not reported as a broken response.
      const fetchImpl = vi.fn(async () => json({ error: 'not_found' }, 404)) as unknown as typeof fetch;
      await expect(client(fetchImpl).status('3'.repeat(32))).rejects.toMatchObject({
        kind: 'unavailable',
      });
    });

    it('never throws out of cancel', async () => {
      // A cancel that cannot reach the service still stops this client polling,
      // which is the part the user can see.
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch;
      await expect(client(fetchImpl).cancel('4'.repeat(32))).resolves.toBeUndefined();
    });
  });

  describe('mapping to app errors', () => {
    it('maps every failure kind to a retryable app error', () => {
      // None of them may be fatal: the user still has their Teacher version.
      for (const kind of ['unavailable', 'timeout', 'invalid_response', 'rejected', 'cancelled'] as const) {
        const mapped = toAppError(new MusicianError(kind, 'x'));
        expect(mapped.code.startsWith('musician_')).toBe(true);
        expect(mapped.recovery).toBe('retry');
      }
    });

    it('maps an unknown throw to an unavailable musician', () => {
      expect(toAppError(new Error('who knows')).code).toBe('musician_unavailable');
    });
  });
});
