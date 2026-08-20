import { NextResponse } from 'next/server';
import type { PublishReceipt } from '@contracts';
import { isPublishConfigured, SITE_URL } from '@/server/config';
import { createPublished, findAny, toPublicSketch } from '@/server/db';
import {
  createSchema,
  newManageToken,
  sanitizeTitle,
  urlBelongsTo,
  verifyTicket,
} from '@/server/publish';
import { rateLimit, requestKey } from '@/server/ratelimit';

/**
 * US-1004 - create the published record.
 *
 * The last step, and the only one that writes anything durable. By the time it
 * runs, the audio and MIDI are already in storage; this turns them into a
 * shareable thing.
 *
 * Order of checks matters: the ticket is verified before the URLs are looked
 * at, and the URLs are verified against the ticket's id before anything is
 * written. A request that fails any of them writes nothing at all.
 */
export const runtime = 'nodejs';

const LIMIT = 6;
const WINDOW_SEC = 60;

export async function POST(request: Request): Promise<Response> {
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'publishing_disabled' }, { status: 503 });
  }

  const limit = rateLimit(requestKey(request, 'publish'), LIMIT, WINDOW_SEC);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const input = parsed.data;

  const ticket = verifyTicket(input.ticket);
  if (ticket === null) {
    return NextResponse.json({ error: 'invalid_or_expired_ticket' }, { status: 403 });
  }

  // The client returns whatever URL the store gave it. Both must live under the
  // prefix this ticket authorized, or the record would point at someone else's
  // object.
  if (!urlBelongsTo(input.audioUrl, ticket.id) || !urlBelongsTo(input.midiUrl, ticket.id)) {
    return NextResponse.json({ error: 'object_outside_prefix' }, { status: 403 });
  }

  // A replayed ticket must not overwrite an existing record. `ON CONFLICT DO
  // NOTHING` in the insert already makes this safe; checking first lets a
  // genuine retry return the same receipt instead of an error.
  const existing = await findAny(ticket.id);
  if (existing !== null) {
    if (existing.deleted_at !== null) {
      return NextResponse.json({ error: 'already_deleted' }, { status: 409 });
    }
    return NextResponse.json({ error: 'already_published' }, { status: 409 });
  }

  const manage = newManageToken();

  try {
    await createPublished({
      id: ticket.id,
      title: sanitizeTitle(input.title),
      bpm: input.bpm,
      mode: input.mode,
      keyRoot: input.keyRoot,
      keyMode: input.keyMode,
      instrumentId: input.instrumentId,
      audioKey: new URL(input.audioUrl).pathname.replace(/^\//, ''),
      audioUrl: input.audioUrl,
      midiKey: new URL(input.midiUrl).pathname.replace(/^\//, ''),
      midiUrl: input.midiUrl,
      durationSec: input.durationSec,
      locale: input.locale,
      manageTokenHash: manage.hash,
    });
  } catch {
    return NextResponse.json({ error: 'write_failed' }, { status: 500 });
  }

  const row = await findAny(ticket.id);
  if (row === null) return NextResponse.json({ error: 'write_failed' }, { status: 500 });

  const receipt: PublishReceipt = {
    sketch: toPublicSketch(row),
    shareUrl: `${SITE_URL}/s/${ticket.id}`,
    // Shown once and stored on the client. There is no way to retrieve it
    // again, which is exactly why the UI copy tells the user to keep it.
    manageToken: manage.token,
  };

  return NextResponse.json(receipt, { status: 201 });
}
