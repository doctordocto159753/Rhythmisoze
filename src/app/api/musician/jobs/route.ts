/**
 * POST /api/musician/jobs — submit Teacher material for generation.
 *
 * A thin proxy. It deliberately does not interpret the payload beyond two
 * checks, because reimplementing the service's validation here would create a
 * second definition of the contract that can drift from the first.
 *
 * The two checks it does make are the ones that must not depend on the service
 * being correct:
 *
 *  1. **Nothing binary crosses this boundary.** The request must be JSON of a
 *     bounded size. If an audio blob is ever passed to this route by mistake,
 *     it is refused here rather than forwarded (AC-03).
 *  2. **The service address never reaches the client**, including in errors.
 */

import { NextResponse } from 'next/server';
import { musicianConfig } from '../config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Symbolic note data for a few minutes of music is tens of kilobytes. A
 * megabyte is far beyond any legitimate request and comfortably below anything
 * that would be an audio file worth sending.
 */
const MAX_BODY_BYTES = 1_048_576;

export async function POST(request: Request): Promise<NextResponse> {
  const config = musicianConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: 'musician_disabled', detail: 'the musician service is not configured' },
      { status: 503 },
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return NextResponse.json(
      { error: 'unsupported_media_type', detail: 'this endpoint accepts symbolic JSON only' },
      { status: 415 },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: 'payload_too_large', detail: 'symbolic note data should not be this large' },
      { status: 413 },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const upstream = await fetch(`${config.baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
      signal: controller.signal,
      cache: 'no-store',
    });

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (error) {
    // The message is deliberately generic. An upstream connection error names
    // the host and port it failed to reach, and that is exactly the thing this
    // proxy exists to keep out of the browser.
    const timedOut = error instanceof DOMException && error.name === 'AbortError';
    return NextResponse.json(
      {
        error: timedOut ? 'musician_timeout' : 'musician_unavailable',
        detail: timedOut ? 'the musician service did not respond in time' : undefined,
      },
      { status: 503 },
    );
  } finally {
    clearTimeout(timer);
  }
}
