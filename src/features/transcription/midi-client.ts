/** Thin transport for server-owned MIDI canonicalization. */

import {
  AppError,
  type CreationMode,
  type InputClassification,
  type JudgeVerdict,
  type MusicalPhraseModel,
} from '@contracts';
import type { MidiImportResult } from '@midi';
import type { PerformanceRhythm } from '@rhythm-extraction';

export interface ServerMidiImportResult extends MidiImportResult {
  mode: CreationMode;
  classification: InputClassification;
  judge: JudgeVerdict | null;
  phraseModel: MusicalPhraseModel | null;
  rhythmAnalysis: PerformanceRhythm | null;
  pitchedNotesAsRhythm: number;
}

export async function importMidiOnServer(
  file: Blob,
  correction?: 'melody' | 'rhythm',
): Promise<ServerMidiImportResult> {
  const body = new FormData();
  body.append('midi', file, 'source.mid');
  if (correction) body.append('correction', correction);
  let response: Response;
  try {
    response = await fetch('/api/transcription/midi', { method: 'POST', body });
  } catch (error) {
    throw new AppError('transcription_failed', 'retry', 'MIDI service is unreachable', { cause: error });
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isResult(payload)) {
    const detail = typeof payload === 'object' && payload !== null &&
      typeof (payload as Record<string, unknown>).detail === 'string'
      ? (payload as Record<string, string>).detail
      : 'MIDI parse failed';
    throw new AppError(response.status === 413 ? 'file_too_large' : 'midi_invalid', 'retry', detail);
  }
  return payload;
}

function isResult(value: unknown): value is ServerMidiImportResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return Array.isArray(result.notes) && Array.isArray(result.drums) &&
    typeof result.rawTranscription === 'object' && result.rawTranscription !== null &&
    (result.mode === 'melody' || result.mode === 'rhythm') &&
    typeof result.classification === 'object' && result.classification !== null;
}
