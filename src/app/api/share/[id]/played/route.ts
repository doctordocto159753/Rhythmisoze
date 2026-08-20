import { NextResponse } from 'next/server';
import { isPublishConfigured } from '@/server/config';
import { findPublished, incrementPlayCount } from '@/server/db';
import { rateLimit, requestKey } from '@/server/ratelimit';

/**
 * The play counter for the share funnel (US-1101: "share page viewed").
 *
 * Carries the sketch id and nothing else - no session, no cookie, no
 * fingerprint. It is a coarse popularity number, not analytics about a person.
 *
 * Rate limited because it is the one unauthenticated write in the product, and
 * an inflated counter is the least interesting thing an attacker could do with
 * it but still not worth allowing.
 */
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isPublishConfigured()) return NextResponse.json({ ok: false }, { status: 503 });

  const limit = rateLimit(requestKey(request, 'played'), 30, 60);
  if (!limit.allowed) return NextResponse.json({ ok: false }, { status: 429 });

  const { id } = await params;
  const row = await findPublished(id);
  if (row === null) return NextResponse.json({ ok: false }, { status: 404 });

  await incrementPlayCount(id);
  return NextResponse.json({ ok: true });
}
