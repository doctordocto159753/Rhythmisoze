/**
 * GET /api/transcription/status — is there a second opinion available?
 *
 * Reports a boolean pair and nothing else. The client's only decision is
 * whether to ask, and whether to tell the user their recording will leave the
 * device; neither needs the service URL, the model revision or the engine's
 * name.
 */

import { NextResponse } from 'next/server';
import { transcriptionConfig } from '../config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const config = transcriptionConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { enabled: false, reachable: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    // `/ready` returns 503 when the weights are absent. That is "configured but
    // unable to work" — an operator who has not run the model bootstrap — and
    // it is reported as unreachable because the effect on the client is the
    // same: do not ask, and do not promise the user anything about it.
    const upstream = await fetch(`${config.baseUrl}/ready`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    return NextResponse.json(
      { enabled: true, reachable: upstream.ok },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { enabled: true, reachable: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  } finally {
    clearTimeout(timer);
  }
}
