import { NextResponse } from 'next/server';
import { isPublishConfigured, MAX_PUBLISH_DURATION_SEC } from '@/server/config';
import { issueTicket, newPublicId, objectPrefix, prepareSchema, ticketExpiry } from '@/server/publish';
import { rateLimit, requestKey } from '@/server/ratelimit';

/**
 * US-1003, step 1 - mint an id and a signed ticket.
 *
 * The server owns the id. That single decision is what makes anonymous
 * publishing safe: a client cannot pick an id, so it cannot aim an upload or a
 * record at one that is already in use.
 *
 * Nothing is written to the database here. A user who abandons the flow after
 * this point leaves no row and no object behind.
 */
export const runtime = 'nodejs';

/** US-1008: six prepares a minute is generous for a person, useless for a loop. */
const LIMIT = 6;
const WINDOW_SEC = 60;

export async function POST(request: Request): Promise<Response> {
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'publishing_disabled' }, { status: 503 });
  }

  const limit = rateLimit(requestKey(request, 'prepare'), LIMIT, WINDOW_SEC);
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

  const parsed = prepareSchema.safeParse(body);
  if (!parsed.success) {
    // The message names the constraint, not the internal schema: it is shown to
    // a developer in a console, never to a user.
    return NextResponse.json(
      { error: 'invalid_request', limits: { maxDurationSec: MAX_PUBLISH_DURATION_SEC } },
      { status: 400 },
    );
  }

  const id = newPublicId();
  return NextResponse.json({
    id,
    ticket: issueTicket({ id, expiresAt: ticketExpiry() }),
    prefix: objectPrefix(id),
  });
}
