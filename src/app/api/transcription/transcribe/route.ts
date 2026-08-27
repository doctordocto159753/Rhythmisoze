/** Authoritative transcription proxy and server-side derivation boundary. */

import { NextResponse, type NextRequest } from 'next/server';
import type {
  DrumEvent,
  InputClassification,
  RawTranscription,
} from '@contracts';
import { rawNotesForProcessing } from '@raw-transcription';
import { buildMusicalPhraseModel } from '@/packages/musical-phrase';
import { analyzeDrumRhythm, analyzeMelodyRhythm } from '@rhythm-extraction';
import { transcriptionConfig } from '../config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = transcriptionConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: 'transcription_unavailable', detail: 'authoritative service is not configured' },
      { status: 503 },
    );
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 });
  }

  let audio: Blob;
  let mode = 'auto';
  try {
    const form = await request.formData();
    const field = form.get('audio');
    if (!(field instanceof Blob) || field.size === 0) {
      return NextResponse.json({ error: 'no_audio' }, { status: 400 });
    }
    if (field.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'too_large' }, { status: 413 });
    }
    const requestedMode = form.get('mode');
    if (
      typeof requestedMode === 'string' &&
      ['auto', 'voice', 'instrument', 'rhythm'].includes(requestedMode)
    ) {
      mode = requestedMode;
    }
    audio = field;
  } catch {
    return NextResponse.json({ error: 'malformed' }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = new FormData();
    body.append('audio', audio, 'take.wav');
    body.append('mode', mode);
    const upstream = await fetch(`${config.baseUrl}/transcribe`, {
      method: 'POST',
      body,
      signal: controller.signal,
      cache: 'no-store',
    });
    const payload = await readJson(upstream);
    if (!upstream.ok) {
      return NextResponse.json(
        {
          error: upstream.status === 503 ? 'transcription_unavailable' : 'transcription_failed',
          detail: readDetail(payload),
        },
        { status: upstream.status },
      );
    }

    const raw = readRawTranscription(payload);
    const classification = readClassification(payload);
    if (raw === null || classification === null) {
      return NextResponse.json(
        { error: 'transcription_failed', detail: 'invalid authoritative Raw contract' },
        { status: 502 },
      );
    }

    const notes = rawNotesForProcessing(raw);
    const drums = raw.drums.map((drum) => ({ ...drum }));
    const melody = classification.type !== 'rhythm';
    const phraseModel = melody && notes.length > 0
      ? buildMusicalPhraseModel(notes, {
          sourceKind: classification.type === 'polyphonic' ? 'polyphonic' : 'symbolic',
          interpretationNotes: notes,
        })
      : undefined;
    const judge = melody
      ? {
          notes: notes.map((note) => ({ ...note })),
          score: 1,
          scoreBefore: 1,
          repairs: [],
          unsupportedNotesRemoved: 0,
          octaveErrorsCorrected: 0,
        }
      : undefined;
    const rhythmAnalysis = melody
      ? notes.length > 0 ? analyzeMelodyRhythm(notes, raw.sourceDurationSec) : null
      : drums.length > 0 ? analyzeDrumRhythm(drums, raw.sourceDurationSec) : null;
    const elapsedMs = readElapsed(payload);

    return NextResponse.json({
      rawTranscription: raw,
      notes,
      drums,
      durationSec: raw.sourceDurationSec,
      phraseModel,
      judge,
      rhythmAnalysis,
      diagnostics: {
        transcriberId: raw.provenance.transcriber === 'game' ? 'game' : 'server',
        backend: 'server',
        elapsedMs,
        modelLoadMs: 0,
        modelFromCache: true,
        notesBeforeFilter: raw.notes.length + raw.drums.length,
        notesAfterFilter: notes.length + drums.length,
        warnings: [`input_classified:${classification.type}:${classification.confidence.toFixed(3)}`],
        classification,
      },
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'transcription_unavailable',
        detail: error instanceof Error && error.name === 'AbortError'
          ? 'authoritative transcription timed out'
          : 'authoritative transcription service is unreachable',
      },
      { status: 503 },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readDetail(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'upstream failure';
  const detail = (payload as Record<string, unknown>).detail;
  return typeof detail === 'string' ? detail : 'upstream failure';
}

function readElapsed(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const elapsed = (payload as Record<string, unknown>).elapsedMs;
  return typeof elapsed === 'number' && Number.isFinite(elapsed) ? elapsed : 0;
}

function readClassification(payload: unknown): InputClassification | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = (payload as Record<string, unknown>).classification;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const value = candidate as Record<string, unknown>;
  if (
    !['melody', 'polyphonic', 'rhythm', 'mixed', 'unknown'].includes(String(value.type)) ||
    typeof value.confidence !== 'number' ||
    !Array.isArray(value.reasoning)
  ) return null;
  return candidate as InputClassification;
}

function readRawTranscription(payload: unknown): RawTranscription | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = (payload as Record<string, unknown>).rawTranscription;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const raw = candidate as Record<string, unknown>;
  if (
    raw.version !== 1 || raw.sourceKind !== 'audio' ||
    !Array.isArray(raw.notes) || !Array.isArray(raw.drums) ||
    typeof raw.sourceDurationSec !== 'number' || !Number.isFinite(raw.sourceDurationSec) ||
    typeof raw.provenance !== 'object' || raw.provenance === null
  ) return null;
  for (const entry of raw.notes) {
    if (typeof entry !== 'object' || entry === null) return null;
    const note = entry as Record<string, unknown>;
    if (
      !finite(note.startSec) || !finite(note.endSec) || !finite(note.pitchMidi) ||
      (note.endSec as number) <= (note.startSec as number) ||
      (note.pitchMidi as number) < 0 || (note.pitchMidi as number) > 127
    ) return null;
  }
  for (const entry of raw.drums) {
    if (!readDrum(entry)) return null;
  }
  return candidate as RawTranscription;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readDrum(value: unknown): value is DrumEvent {
  if (typeof value !== 'object' || value === null) return false;
  const drum = value as Record<string, unknown>;
  return finite(drum.timeSec) && typeof drum.drum === 'string' && finite(drum.velocity);
}
