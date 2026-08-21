/**
 * POST /api/publish/upload — receive a published file directly.
 *
 * The self-hosted counterpart of the Vercel token flow. There is no 4.5 MB
 * Function limit on a box you own, so the simplest correct thing is for the app
 * to accept the bytes.
 *
 * Every constraint the token route pins is pinned here too, because this is the
 * same trust boundary reached by a different road:
 *
 *  - a **signed ticket** is required, and the object key must sit under the
 *    prefix that ticket authorises;
 *  - only `audio.wav` and `sketch.mid` may be written;
 *  - the per-file byte caps from config apply, checked against the actual body
 *    rather than a declared content-length.
 */

import { NextResponse } from 'next/server';
import { isPublishConfigured, MAX_AUDIO_BYTES, MAX_MIDI_BYTES } from '@/server/config';
import { objectPrefix, verifyTicket } from '@/server/publish';
import { storage } from '@/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED: Record<string, { contentType: string; maxBytes: number }> = {
  'audio.wav': { contentType: 'audio/wav', maxBytes: MAX_AUDIO_BYTES },
  'sketch.mid': { contentType: 'audio/midi', maxBytes: MAX_MIDI_BYTES },
};

export async function POST(request: Request): Promise<Response> {
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'publishing_disabled' }, { status: 503 });
  }

  const driver = storage();
  if (driver.uploadPlan().kind !== 'direct') {
    // The Vercel deployment uses the token route. Accepting bytes here would
    // work in development and fail in production for want of a body limit.
    return NextResponse.json({ error: 'wrong_upload_mode' }, { status: 400 });
  }

  const url = new URL(request.url);
  const ticketValue = url.searchParams.get('ticket') ?? '';
  const pathname = url.searchParams.get('pathname') ?? '';

  const ticket = verifyTicket(ticketValue);
  if (ticket === null) {
    return NextResponse.json({ error: 'invalid_ticket' }, { status: 403 });
  }

  const prefix = objectPrefix(ticket.id);
  if (!pathname.startsWith(prefix)) {
    return NextResponse.json({ error: 'pathname_outside_prefix' }, { status: 403 });
  }

  const rule = ALLOWED[pathname.slice(prefix.length)];
  if (!rule) {
    return NextResponse.json({ error: 'unexpected_filename' }, { status: 400 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  // Checked against the real body, not a header a client controls.
  if (body.byteLength === 0) {
    return NextResponse.json({ error: 'empty_body' }, { status: 400 });
  }
  if (body.byteLength > rule.maxBytes) {
    return NextResponse.json(
      { error: 'file_too_large', limit: rule.maxBytes },
      { status: 413 },
    );
  }

  const stored = await driver.put(pathname, body, rule.contentType);
  return NextResponse.json({ url: stored.url, bytes: stored.bytes });
}
