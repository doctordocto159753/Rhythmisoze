/**
 * US-0303 / US-0305 - the main-thread side of transcription.
 *
 * Owns exactly one worker for the lifetime of the tab. Spawning one per take
 * would reload TensorFlow.js and the model every time; keeping a pool would be
 * pointless because a person records one thing at a time.
 *
 * Cancellation is real: the worker is told to stop, the promise rejects with
 * `transcription_cancelled`, and - the part that is easy to get wrong - the
 * pending entry is removed so a late `result` message from an abandoned run
 * cannot resolve the next one (US-0303: "cancel/retry does not leave orphan
 * workers or corrupted state").
 */

import {
  AppError,
  type AppErrorCode,
  type MonoAudio,
  type RecoveryAction,
  type TranscriptionProgress,
  type TranscriptionResult,
} from '@contracts';
import type { WorkerRequest, WorkerResponse } from '@/workers/transcription.worker';

export interface TranscribeOptions {
  mode: 'melody' | 'rhythm';
  /** `false` forces the built-in tracker. */
  allowModel?: boolean;
  noteThreshold?: number;
  onsetThreshold?: number;
  minNoteLengthSec?: number;
  onProgress?(progress: TranscriptionProgress): void;
  signal?: AbortSignal;
}

/**
 * Defaults.
 *
 * `noteThreshold` and `onsetThreshold` are the model's own confidence gates.
 * Melody uses the library's conservative baseline. A YIN guide now fills gaps
 * and rejects octave/sub-octave activations, so lowering these gates only adds
 * breath and transition noise without buying recall.
 */
const DEFAULTS = {
  noteThreshold: 0.3,
  onsetThreshold: 0.5,
  minNoteLengthSec: 0.12,
} as const;

export const MODEL_URL =
  process.env.NEXT_PUBLIC_BASIC_PITCH_MODEL_URL || '/models/basic-pitch/model.json';

interface Pending {
  resolve(result: TranscriptionResult): void;
  reject(error: AppError): void;
  onProgress?(progress: TranscriptionProgress): void;
}

let worker: Worker | null = null;
const pending = new Map<string, Pending>();
let counter = 0;

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  if (typeof Worker === 'undefined') {
    throw new AppError('worker_unavailable', 'reload', 'no Worker');
  }

  worker = new Worker(new URL('../../workers/transcription.worker.ts', import.meta.url), {
    type: 'module',
    name: 'rhythmisoze-transcription',
  });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;

    if (message.type === 'progress') {
      entry.onProgress?.({
        stage: message.stage as TranscriptionProgress['stage'],
        progress: message.progress,
      });
      return;
    }
    pending.delete(message.id);
    if (message.type === 'result') entry.resolve(message.result);
    else {
      entry.reject(
        new AppError(
          message.code as AppErrorCode,
          message.recovery as RecoveryAction,
          message.detail,
        ),
      );
    }
  };

  worker.onerror = () => {
    // The worker itself died. Every waiting caller must hear about it, and the
    // next call gets a fresh worker rather than a dead handle.
    const error = new AppError('worker_unavailable', 'reload', 'worker error');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

export async function transcribe(
  audio: MonoAudio,
  options: TranscribeOptions,
): Promise<TranscriptionResult> {
  const instance = ensureWorker();
  const id = `t${(counter += 1)}`;

  return new Promise<TranscriptionResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: options.onProgress });

    const abort = (): void => {
      if (!pending.has(id)) return;
      pending.delete(id);
      instance.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
      reject(new AppError('transcription_cancelled', 'none', 'user cancelled'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    if (options.signal?.aborted === true) {
      abort();
      return;
    }

    // The sample buffer is transferred rather than copied: a 60 s take at
    // 44.1 kHz is 10 MB, and structured-cloning it doubles peak memory on
    // exactly the low-end phones the performance gate cares about.
    const samples = new Float32Array(audio.samples);
    const request: WorkerRequest = {
      type: 'transcribe',
      id,
      mode: options.mode,
      samples,
      sampleRate: audio.sampleRate,
      durationSec: audio.durationSec,
      modelUrl: MODEL_URL,
      allowModel: options.allowModel !== false,
      noteThreshold: options.noteThreshold ?? DEFAULTS.noteThreshold,
      onsetThreshold: options.onsetThreshold ?? DEFAULTS.onsetThreshold,
      minNoteLengthSec: options.minNoteLengthSec ?? DEFAULTS.minNoteLengthSec,
    };
    instance.postMessage(request, [samples.buffer]);
  });
}

/**
 * US-0302 - warm the model before it is needed.
 *
 * Called on hover/focus of the record control, so the download overlaps the
 * seconds a user spends setting their tempo. If it fails, nothing happens: the
 * real transcription will try again and report properly.
 */
export function warmModel(): void {
  if (typeof window === 'undefined') return;
  try {
    ensureWorker();
    void fetch(MODEL_URL, { cache: 'force-cache' }).catch(() => undefined);
  } catch {
    // Warming is best-effort by definition.
  }
}

/** Tears the worker down. Used when the page unloads and by tests. */
export function disposeTranscriber(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
