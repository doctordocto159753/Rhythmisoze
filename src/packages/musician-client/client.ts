/**
 * Typed client for the Musician service.
 *
 * ## What it talks to
 *
 * The app's own `/api/musician/*` routes, never the service directly. The proxy
 * exists so the service URL and any credential stay server-side, and so the
 * browser cannot be pointed at an internal worker by editing a bundle
 * (integration brief §15).
 *
 * ## What it sends
 *
 * Teacher notes plus the analysis metadata the service needs to interpret them:
 * tempo, meter, key. **Never audio.** There is no field on `MusicianRequest`
 * that could carry a Blob, which makes AC-03 a property of the type rather than
 * a rule someone has to remember.
 *
 * ## What it does with failure
 *
 * Classifies it and returns. Every failure mode here — unreachable, timeout,
 * malformed, model down, queue full — leaves the user with a working Teacher
 * version and a retry, so none of them may throw past the caller as something
 * fatal.
 */

import { AppError } from '@contracts';
import type { NoteEvent } from '@contracts';
import {
  jobAcceptedSchema,
  jobStatusSchema,
  type MusicianJobStatus,
  type MusicianResult,
} from './schema';

export interface MusicianRequest {
  /** Identifies the sketch, so a result can be matched to it on return. */
  sourceId: string;
  /** Teacher notes. The registry asserts this is Teacher material (AC-02). */
  notes: readonly NoteEvent[];
  bpm: number;
  tempoConfidence: number;
  meter: { numerator: number; denominator: number; confidence: number };
  key: { tonic: string; mode: 'major' | 'minor'; confidence: number } | null;
  durationSec: number;
  /** Omitted on a first attempt; set by "Try another" to force a new result. */
  seed?: number;
}

/**
 * Why a Musician request did not produce a result.
 *
 * Distinguished because the recovery differs: `unavailable` is worth retrying
 * in a moment, `invalid_response` means retrying the same input will fail the
 * same way, and `cancelled` is not a failure at all.
 */
export type MusicianFailureKind =
  | 'disabled'
  | 'unavailable'
  | 'timeout'
  | 'invalid_response'
  | 'rejected'
  | 'cancelled';

export class MusicianError extends Error {
  constructor(
    readonly kind: MusicianFailureKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'MusicianError';
  }
}

export interface MusicianClientOptions {
  /** Same-origin by default; overridden in tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** How long to wait for the whole generation before giving up. */
  timeoutMs?: number;
  /** How often to ask. See the note on backoff below. */
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 1_500;

/**
 * Poll interval, and why it is not adaptive.
 *
 * Generation takes seconds to minutes and there is exactly one job in flight
 * per user. Exponential backoff would save a handful of requests and cost the
 * user up to its own interval in latency at the moment the result arrives —
 * which is the one moment they are watching. A flat interval is the right
 * trade here; it would not be for a service with thousands of concurrent jobs.
 */
export class MusicianClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: MusicianClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  /** Submit Teacher material. Returns a job id; generation happens behind it. */
  async submit(request: MusicianRequest, signal?: AbortSignal): Promise<string> {
    const body = {
      teacher: {
        sourceId: request.sourceId,
        // NoteEvent already uses the contract's field names, so this is a
        // clamp rather than a translation. The clamps are not paranoia: a
        // velocity of 0 or a pitch of 128 is refused by the service, and
        // failing here with a clear reason beats a 422 from across a network.
        notes: request.notes.map((note) => ({
          pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
          startSec: note.startSec,
          endSec: note.endSec,
          velocity: Math.max(1, Math.min(127, Math.round(note.velocity))),
        })),
        tempo: { bpm: request.bpm, confidence: request.tempoConfidence },
        meter: request.meter,
        key: request.key,
        durationSec: request.durationSec,
      },
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    };

    const response = await this.call('/api/musician/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (response.status === 503) {
      throw new MusicianError('unavailable', 'the musician service is not available');
    }
    if (response.status === 422) {
      // The service refused the input. Retrying the same input will fail the
      // same way, so this is not offered as a transient error.
      const detail = await safeText(response);
      throw new MusicianError('rejected', 'the musician service refused this material', detail);
    }
    if (!response.ok) {
      throw new MusicianError('unavailable', `musician service returned ${response.status}`);
    }

    const parsed = jobAcceptedSchema.safeParse(await safeJson(response));
    if (!parsed.success) {
      throw new MusicianError('invalid_response', 'the musician service returned an unusable reply');
    }
    return parsed.data.jobId;
  }

  async status(jobId: string, signal?: AbortSignal): Promise<MusicianJobStatus> {
    const response = await this.call(`/api/musician/jobs/${encodeURIComponent(jobId)}`, { signal });
    if (response.status === 404) {
      // The service restarted with an ephemeral queue, or the job expired.
      // Recoverable by starting again, so it is reported as unavailable rather
      // than as a broken response.
      throw new MusicianError('unavailable', 'that generation is no longer known to the service');
    }
    if (!response.ok) {
      throw new MusicianError('unavailable', `musician service returned ${response.status}`);
    }

    const parsed = jobStatusSchema.safeParse(await safeJson(response));
    if (!parsed.success) {
      throw new MusicianError(
        'invalid_response',
        'the musician service returned an unusable reply',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }
    return parsed.data;
  }

  async cancel(jobId: string): Promise<void> {
    try {
      await this.call(`/api/musician/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    } catch {
      // A cancel that fails to reach the service still stops this client
      // polling, which is the part the user can see. The job will time out on
      // the server. Surfacing an error here would tell them something is wrong
      // when nothing they care about is.
    }
  }

  /**
   * Submit and wait, reporting progress.
   *
   * `onPhase` exists because "running" means two different things to a person:
   * the whole-melody pass and the local repair pass. The service reports one
   * state; the client infers the second from elapsed time, and says so in the
   * only place it matters — a progress label, never a claim in a result.
   */
  async generate(
    request: MusicianRequest,
    callbacks: {
      onJobId?(jobId: string): void;
      onPhase?(phase: 'queued' | 'generating_global' | 'refining_local'): void;
      signal?: AbortSignal;
    } = {},
  ): Promise<MusicianResult> {
    const jobId = await this.submit(request, callbacks.signal);
    callbacks.onJobId?.(jobId);
    return this.await(jobId, callbacks);
  }

  /** Wait on a job that already exists — used when a workspace is reopened. */
  async await(
    jobId: string,
    callbacks: {
      onPhase?(phase: 'queued' | 'generating_global' | 'refining_local'): void;
      signal?: AbortSignal;
    } = {},
  ): Promise<MusicianResult> {
    const startedAt = Date.now();
    let runningSince: number | null = null;
    let lastPhase: string | null = null;

    for (;;) {
      if (callbacks.signal?.aborted) {
        await this.cancel(jobId);
        throw new MusicianError('cancelled', 'generation was cancelled');
      }
      if (Date.now() - startedAt > this.timeoutMs) {
        await this.cancel(jobId);
        throw new MusicianError('timeout', 'generation took too long');
      }

      const status = await this.status(jobId, callbacks.signal);

      if (status.state === 'succeeded') {
        if (!status.result) {
          throw new MusicianError('invalid_response', 'the generation finished with no result');
        }
        return status.result;
      }
      if (status.state === 'failed') {
        throw new MusicianError('unavailable', 'the generation did not finish', status.error);
      }
      if (status.state === 'cancelled') {
        throw new MusicianError('cancelled', 'generation was cancelled');
      }

      if (status.state === 'running') {
        runningSince ??= Date.now();
        // The local-repair pass runs after the whole-melody pass. The service
        // does not report the boundary, and adding a state to it for a progress
        // label would be tail wagging dog. Eight seconds is a rough divider and
        // is used for a label only — nothing downstream depends on it.
        const phase = Date.now() - runningSince > 8_000 ? 'refining_local' : 'generating_global';
        if (phase !== lastPhase) {
          lastPhase = phase;
          callbacks.onPhase?.(phase);
        }
      } else if (lastPhase !== 'queued') {
        lastPhase = 'queued';
        callbacks.onPhase?.('queued');
      }

      await delay(this.pollIntervalMs, callbacks.signal);
    }
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new MusicianError('cancelled', 'generation was cancelled');
      }
      throw new MusicianError(
        'unavailable',
        'could not reach the musician service',
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}

/** Maps a client failure onto the app's own error vocabulary. */
export function toAppError(error: unknown): AppError {
  if (error instanceof MusicianError) {
    switch (error.kind) {
      case 'cancelled':
        return new AppError('musician_cancelled', 'retry', error.detail);
      case 'timeout':
        return new AppError('musician_timeout', 'retry', error.detail);
      case 'rejected':
      case 'invalid_response':
        return new AppError('musician_failed', 'retry', error.detail ?? error.message);
      case 'disabled':
      case 'unavailable':
      default:
        return new AppError('musician_unavailable', 'retry', error.detail);
    }
  }
  return new AppError('musician_unavailable', 'retry');
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MusicianError('cancelled', 'generation was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
