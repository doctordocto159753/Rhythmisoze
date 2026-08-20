import { NextResponse } from 'next/server';
import { isPublishConfigured } from '@/server/config';
import { findAny, findPublished, softDelete, toPublicSketch } from '@/server/db';
import { manageTokenMatches } from '@/server/publish';
import { rateLimit, requestKey } from '@/server/ratelimit';

/**
 * US-1007 - read and delete a published sketch.
 *
 * The delete path is the whole reason the management token exists (Q-C1). Two
 * properties it has to hold:
 *
 *  - **Only the owner can delete.** The token is compared against a stored
 *    SHA-256 hash in constant time, so neither a database dump nor a timing
 *    measurement hands out delete rights.
 *  - **It is not an oracle.** A wrong token, an unknown id and an
 *    already-deleted sketch all return exactly the same 404. Distinguishing
 *    them would let anyone enumerate which share links exist.
 */
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'publishing_disabled' }, { status: 503 });
  }
  const { id } = await params;
  const row = await findPublished(id);
  if (row === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json(toPublicSketch(row), {
    headers: {
      // A published sketch is immutable except for its play count, so it can be
      // cached hard at the edge and revalidated in the background.
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'publishing_disabled' }, { status: 503 });
  }

  const limit = rateLimit(requestKey(request, 'unpublish'), 20, 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } },
    );
  }

  const { id } = await params;
  const token = request.headers.get('x-manage-token') ?? '';
  const notFound = NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (token === '') return notFound;

  const row = await findAny(id);
  if (row === null || row.deleted_at !== null) return notFound;
  if (!manageTokenMatches(token, row.manage_token_hash)) return notFound;

  const deleted = await softDelete(id);
  if (!deleted) return notFound;

  // Audited without recording anything about the content (Playbook 17).
  console.info(`[publish] deleted sketch ${id}`);

  return NextResponse.json({ deleted: true });
}
