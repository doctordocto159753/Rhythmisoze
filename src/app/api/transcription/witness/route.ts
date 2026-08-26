/**
 * POST /api/transcription/witness — one take in, one engine's note list out.
 *
 * The only route in this application that accepts a recording. Everything about
 * it is written on the assumption that this is the interesting fact:
 *
 *  - it is refused unless the operator has switched the service on;
 *  - the audio is streamed to the service and never written down here;
 *  - nothing about the take is logged;
 *  - a failure is a 204, not a 500, because the caller's correct response to
 *    every failure is the same one: carry on without a second opinion.
 *
 * ## Why 204 rather than an error
 *
 * The witness is advisory. The register arbitration needs two engines to agree
 * before it moves a note, so "the service did not answer" and "the service
 * answered and agreed" both end with the transcription the browser already had.
 * Returning a 500 would make the client distinguish failures it cannot act on
 * differently, and would put a red error in front of a user whose take is fine.
 *
 * The one thing the client does need to tell apart is *no opinion* from *an
 * opinion containing no notes*: the second is evidence — the engine listened and
 * heard nothing — and a silent 204 would launder it into the first.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { transcriptionConfig } from '../config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ceiling on the upload this route will relay.
 *
 * The recording cap is sixty seconds; sixty seconds of 16-bit mono at 48 kHz is
 * about 5.8 MB. Sixteen leaves room for a higher rate without becoming a way to
 * push arbitrary volumes of data through a machine that is not expecting it.
 */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = transcriptionConfig();
  if (!config.enabled) {
    // Not an error. The client asks `/status` first and should not be here, but
    // a stale tab is a normal thing to have.
    return new NextResponse(null, { status: 204 });
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 });
  }

  let audio: Blob;
  try {
    const form = await request.formData();
    const field = form.get('audio');
    if (!(field instanceof Blob) || field.size === 0) {
      return NextResponse.json({ error: 'no_audio' }, { status: 400 });
    }
    if (field.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'too_large' }, { status: 413 });
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
    const upstream = await fetch(`${config.baseUrl}/witness`, {
      method: 'POST',
      body,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!upstream.ok) return new NextResponse(null, { status: 204 });

    const payload = (await upstream.json()) as unknown;
    const notes = readNotes(payload);
    if (notes === null) return new NextResponse(null, { status: 204 });

    return NextResponse.json(
      { engine: 'game', notes },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    // Timeout, connection refused, malformed JSON. All of them mean the same
    // thing to the caller.
    return new NextResponse(null, { status: 204 });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates the service's reply before it becomes evidence.
 *
 * The service is trusted infrastructure, not trusted input: it runs a research
 * model through a CLI, and a malformed row reaching the arbitration as a note
 * with a `NaN` pitch would be a silent wrong answer rather than a loud one.
 * `null` means "nothing usable came back", which the caller reports as no
 * opinion; an empty array is a real answer and is preserved as one.
 */
function readNotes(payload: unknown): Array<{ startSec: number; endSec: number; pitch: number }> | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as { notes?: unknown }).notes;
  if (!Array.isArray(raw)) return null;

  const notes: Array<{ startSec: number; endSec: number; pitch: number }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { startSec, endSec, pitch } = entry as Record<string, unknown>;
    if (typeof startSec !== 'number' || !Number.isFinite(startSec)) continue;
    if (typeof endSec !== 'number' || !Number.isFinite(endSec)) continue;
    if (typeof pitch !== 'number' || !Number.isFinite(pitch)) continue;
    if (endSec <= startSec || startSec < 0) continue;
    // Outside this, the value is not a pitch a person sang; MIDI runs 0..127.
    if (pitch < 0 || pitch > 127) continue;
    notes.push({ startSec, endSec, pitch });
  }
  notes.sort((a, b) => a.startSec - b.startSec);
  return notes;
}
