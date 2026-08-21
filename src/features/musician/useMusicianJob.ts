'use client';

/**
 * The Musician generation job, as the UI sees it.
 *
 * ## The rule this hook exists to enforce
 *
 * **Nothing here may ever take away a version the user already has.** The
 * Teacher is on screen and playable before this hook does anything, and every
 * path through it — success, timeout, outage, malformed reply, cancel — ends
 * with the Teacher still on screen and still playable.
 *
 * That is why the reducer has no state that clears `result`, why a failure
 * stores an error *beside* the result rather than instead of it, and why
 * regeneration writes to `pending` rather than to `result` until the user has
 * said which pair to keep.
 *
 * ## Why the phases are not the service's states
 *
 * The service reports pending/running/succeeded. "Running" is one thing to a
 * queue and two things to a person watching a spinner, so the client splits it
 * into a whole-melody phase and a local-repair phase. That split drives a label
 * and nothing else — no stored result depends on it, and it is not reported as
 * fact anywhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppError } from '@contracts';
import type { NoteEvent, StoredMusician, StoredMusicianVersion } from '@contracts';
import {
  MusicianClient,
  MusicianError,
  toAppError,
  type MusicianRequest,
  type MusicianResult,
  type MusicianVariant,
} from '@musician-client';
import {
  MUSICIAN_VERSION_IDS,
  type GeneratedVersion,
  type MusicalVersionId,
  type MusicianVersionId,
} from '@versions';

export type MusicianPhase =
  | 'idle'
  | 'queued'
  | 'generating_global'
  | 'refining_local'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * The set the Musician returns.
 *
 * Still named a "pair" nowhere: it is three versions, and the type says so, so
 * that adding a fourth is a field rather than a rename of everything that
 * touches it.
 */
export interface MusicianSet {
  'musician-refined': GeneratedVersion;
  'musician-developed': GeneratedVersion;
  'musician-expanded': GeneratedVersion;
}

/** @deprecated kept so existing imports keep compiling; use `MusicianSet`. */
export type MusicianPair = MusicianSet;

export interface MusicianJobState {
  phase: MusicianPhase;
  jobId: string | null;
  /** The accepted pair. Never cleared by a later failure or regeneration. */
  result: MusicianPair | null;
  /**
   * A newly generated pair awaiting the user's choice.
   *
   * Regeneration must not destroy something the user may have decided they
   * like. §9 asks for the previous result to survive until they choose, and the
   * cleanest way to guarantee that is for the new one to land somewhere else.
   */
  pending: MusicianPair | null;
  error: AppError | null;
  /** Bumped on every regeneration so the next seed differs. */
  attempt: number;
}

const INITIAL: MusicianJobState = {
  phase: 'idle',
  jobId: null,
  result: null,
  pending: null,
  error: null,
  attempt: 0,
};

export interface MusicianJobSnapshot {
  jobId: string | null;
  phase: MusicianPhase;
  attempt: number;
}

export interface UseMusicianJobOptions {
  enabled: boolean;
  client?: MusicianClient;
  /** Restored from the workspace when a sketch is reopened. */
  restore?: { result: MusicianPair | null; job: MusicianJobSnapshot | null };
  onPersist?(state: { result: MusicianPair | null; job: MusicianJobSnapshot }): void;
}

export function useMusicianJob(options: UseMusicianJobOptions) {
  const { enabled, onPersist } = options;
  const client = useMemo(() => options.client ?? new MusicianClient(), [options.client]);

  const [state, setState] = useState<MusicianJobState>(() =>
    options.restore?.result
      ? { ...INITIAL, result: options.restore.result, phase: 'completed' }
      : INITIAL,
  );

  const abortRef = useRef<AbortController | null>(null);
  // Guards against a resolved promise writing into a component that has moved
  // on -- a stale success arriving after a cancel would otherwise resurrect a
  // generation the user stopped.
  const runIdRef = useRef(0);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const persist = useCallback(
    (next: MusicianJobState) => {
      onPersist?.({
        result: next.result,
        job: { jobId: next.jobId, phase: next.phase, attempt: next.attempt },
      });
    },
    [onPersist],
  );

  const run = useCallback(
    async (request: MusicianRequest, mode: 'first' | 'again') => {
      if (!enabled) {
        setState((current) => ({
          ...current,
          error: new AppError('musician_unavailable', 'retry', 'musician disabled'),
        }));
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const runId = ++runIdRef.current;

      const attempt = mode === 'again' ? state.attempt + 1 : state.attempt;
      setState((current) => ({
        ...current,
        phase: 'queued',
        error: null,
        pending: null,
        attempt,
      }));

      try {
        const result = await client.generate(
          {
            ...request,
            // A regeneration must not be able to return the same pair, or
            // "Try another" would sometimes appear to do nothing.
            seed: request.seed ?? deriveSeed(request.sourceId, attempt),
          },
          {
            signal: controller.signal,
            onJobId: (jobId) => {
              if (runId !== runIdRef.current) return;
              setState((current) => {
                const next = { ...current, jobId };
                persist(next);
                return next;
              });
            },
            onPhase: (phase) => {
              if (runId !== runIdRef.current) return;
              setState((current) => ({ ...current, phase }));
            },
          },
        );

        if (runId !== runIdRef.current) return;

        const pair = toPair(result);
        setState((current) => {
          const next: MusicianJobState = {
            ...current,
            phase: 'completed',
            error: null,
            // First run accepts directly; a regeneration parks the new pair
            // until the user chooses, so nothing they might prefer is lost.
            result: mode === 'first' ? pair : current.result,
            pending: mode === 'first' ? null : pair,
          };
          persist(next);
          return next;
        });
      } catch (error) {
        if (runId !== runIdRef.current) return;
        const cancelled = error instanceof MusicianError && error.kind === 'cancelled';
        setState((current) => {
          const next: MusicianJobState = {
            ...current,
            phase: cancelled ? 'cancelled' : 'failed',
            // The existing pair survives. A model outage is not a reason to
            // take away music the user already has.
            error: cancelled ? null : toAppError(error),
          };
          persist(next);
          return next;
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [client, enabled, persist, state.attempt],
  );

  const generate = useCallback(
    (request: MusicianRequest) => void run(request, 'first'),
    [run],
  );

  const regenerate = useCallback(
    (request: MusicianRequest) => void run(request, 'again'),
    [run],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    runIdRef.current += 1;
    setState((current) => ({ ...current, phase: current.result ? 'completed' : 'cancelled' }));
  }, []);

  /** Adopt a pending regeneration. */
  const keepPending = useCallback(() => {
    setState((current) => {
      if (!current.pending) return current;
      const next = { ...current, result: current.pending, pending: null };
      persist(next);
      return next;
    });
  }, [persist]);

  /** Discard a pending regeneration and keep what was already accepted. */
  const discardPending = useCallback(() => {
    setState((current) => ({ ...current, pending: null }));
  }, []);

  const dismissError = useCallback(() => {
    setState((current) => ({ ...current, error: null, phase: current.result ? 'completed' : 'idle' }));
  }, []);

  const busy =
    state.phase === 'queued' ||
    state.phase === 'generating_global' ||
    state.phase === 'refining_local';

  const generated = useMemo<Partial<Record<MusicalVersionId, GeneratedVersion>>>(() => {
    if (!state.result) return {};
    return {
      'musician-refined': state.result['musician-refined'],
      'musician-developed': state.result['musician-developed'],
      'musician-expanded': state.result['musician-expanded'],
    };
  }, [state.result]);

  return {
    ...state,
    busy,
    generated,
    generate,
    regenerate,
    cancel,
    keepPending,
    discardPending,
    dismissError,
  };
}

/**
 * A seed from the sketch id and attempt number.
 *
 * Deterministic on purpose: reopening a workspace and pressing "Try another"
 * the same number of times reproduces the same request, which is what makes the
 * stored provenance meaningful rather than decorative.
 */
export function deriveSeed(sourceId: string, attempt: number): number {
  let hash = 2166136261;
  const input = `${sourceId}:${attempt}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // Positive and inside the service's accepted range.
  return Math.abs(hash) % 2_147_483_647;
}

function toNotes(variant: MusicianVariant): NoteEvent[] {
  return variant.notes.map((note) => ({
    pitch: note.pitch,
    startSec: note.start_sec,
    endSec: note.end_sec,
    velocity: note.velocity,
  }));
}

function toGenerated(
  id: MusicalVersionId,
  variant: MusicianVariant,
  result: MusicianResult,
  jobId: string,
): GeneratedVersion {
  return {
    id,
    notes: toNotes(variant),
    provenance: {
      jobId,
      seed: result.provenance.seeds.base ?? 0,
      serviceVersion: result.provenance.musician_service_version,
      melodyModelRevision: result.provenance.melody_t5_revision,
      infillModelRevision: result.provenance.midi_rwkv_revision,
      sourceFingerprint: result.provenance.input_fingerprint,
      generatedAt: Date.now(),
      elapsedMs: result.provenance.elapsed_ms,
    },
    identityAggregate: variant.identity.aggregate,
    changedSpans: variant.infill_spans.map((span) => ({
      startIndex: span.start_index,
      endIndex: span.end_index,
      reason: span.reason,
    })),
  };
}

export function toPair(result: MusicianResult, jobId = ''): MusicianSet {
  return {
    'musician-refined': toGenerated('musician-refined', result.refined, result, jobId),
    'musician-developed': toGenerated('musician-developed', result.developed, result, jobId),
    'musician-expanded': toGenerated('musician-expanded', result.expanded, result, jobId),
  };
}

/**
 * Persisted form of the Musician state.
 *
 * A separate shape from `MusicianPair` because what is stored and what is held
 * in memory answer different questions. The stored form has to survive a schema
 * version and be readable by code that does not import this module, so it is
 * plain data keyed by version id — no class instances, no undefined-vs-missing
 * subtleties, nothing that depends on a runtime type.
 */
export function toStoredMusician(
  state: { result: MusicianPair | null; job: MusicianJobSnapshot } | null,
): StoredMusician | undefined {
  if (!state) return undefined;
  const { result, job } = state;
  // Nothing worth storing: no versions and no job to resume.
  if (!result && !job.jobId) return undefined;

  const versions: Record<string, StoredMusicianVersion> = {};
  if (result) {
    for (const id of MUSICIAN_VERSION_IDS) {
      const generated = result[id];
      versions[id] = {
        notes: generated.notes,
        identityAggregate: generated.identityAggregate,
        changedSpans: generated.changedSpans,
        provenance: generated.provenance,
      };
    }
  }

  return {
    versions,
    // A job is only worth recording while it could still be resumed. Storing a
    // finished job id would make a reopened workspace poll something that will
    // never change.
    job:
      job.jobId && job.phase !== 'completed'
        ? { jobId: job.jobId, phase: job.phase, attempt: job.attempt, startedAt: Date.now() }
        : undefined,
  };
}

/** The inverse, for restoring a saved sketch. */
export function fromStoredMusician(stored: StoredMusician | undefined): MusicianPair | null {
  if (!stored) return null;
  // All or nothing. A half-restored set would put a version in the picker whose
  // siblings cannot be compared against it, which is the whole point of having
  // more than one.
  //
  // A workspace saved before Expanded existed has only two, and correctly
  // restores nothing rather than a broken set -- the user regenerates and gets
  // all three (AC-16).
  const restored: Partial<Record<MusicianVersionId, GeneratedVersion>> = {};
  for (const id of MUSICIAN_VERSION_IDS) {
    const entry = stored.versions[id];
    if (!entry) return null;
    restored[id] = { id, ...entry };
  }
  return restored as MusicianSet;
}
