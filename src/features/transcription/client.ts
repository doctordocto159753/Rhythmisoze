/** Thin browser transport for authoritative server-side transcription. */

import {
  AppError,
  type MonoAudio,
  type RawTranscription,
  type TranscriptionInputMode,
  type TranscriptionProgress,
  type TranscriptionResult,
} from '@contracts';
import type { PerformanceRhythm } from '@rhythm-extraction';
import { encodeWav } from '@audio-core';

export interface TranscribeOptions {
  mode: TranscriptionInputMode;
  onProgress?(progress: TranscriptionProgress): void;
  signal?: AbortSignal;
}

export interface ServerTranscriptionResult extends TranscriptionResult {
  rawTranscription: RawTranscription;
  rhythmAnalysis: PerformanceRhythm | null;
}

export async function transcribe(
  audio: MonoAudio,
  options: TranscribeOptions,
): Promise<ServerTranscriptionResult> {
  options.onProgress?.({ stage: 'preparing_audio', progress: 0.05 });
  const wav = encodeWav([audio.samples], { sampleRate: audio.sampleRate });
  const body = new FormData();
  body.append('audio', new Blob([wav], { type: 'audio/wav' }), 'take.wav');
  body.append('mode', options.mode);
  options.onProgress?.({ stage: 'inferring', progress: 0.2 });

  let response: Response;
  try {
    response = await fetch('/api/transcription/transcribe', {
      method: 'POST',
      body,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new AppError('transcription_cancelled', 'none', 'user cancelled', { cause: error });
    }
    throw new AppError(
      'transcription_failed',
      'retry',
      'authoritative transcription service is unreachable',
      { cause: error },
    );
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    const detail = readDetail(payload);
    throw new AppError(
      response.status === 422
        ? 'input_unrecognized'
        : response.status === 503
          ? 'transcription_unavailable'
          : 'transcription_failed',
      response.status === 422 ? 'rerecord' : 'retry',
      detail,
    );
  }
  if (!isServerResult(payload)) {
    throw new AppError('transcription_failed', 'retry', 'invalid authoritative response');
  }
  options.onProgress?.({ stage: 'done', progress: 1 });
  return payload;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readDetail(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'transcription request failed';
  const detail = (payload as Record<string, unknown>).detail;
  return typeof detail === 'string' ? detail : 'transcription request failed';
}

function isServerResult(payload: unknown): payload is ServerTranscriptionResult {
  if (typeof payload !== 'object' || payload === null) return false;
  const value = payload as Record<string, unknown>;
  return (
    typeof value.rawTranscription === 'object' && value.rawTranscription !== null &&
    Array.isArray(value.notes) && Array.isArray(value.drums) &&
    typeof value.durationSec === 'number' &&
    typeof value.diagnostics === 'object' && value.diagnostics !== null &&
    ('rhythmAnalysis' in value)
  );
}
