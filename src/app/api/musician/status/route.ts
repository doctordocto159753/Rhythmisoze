/**
 * GET /api/musician/status — is the feature available at all?
 *
 * The browser cannot read `MUSICIAN_ENABLED`, and it should not: server
 * configuration reaching a bundle is how a URL leaks. So it asks.
 *
 * This deliberately reports only a boolean and a coarse reachability flag. It
 * does not report the service URL, the model revisions, or the queue depth —
 * those are operator concerns, and the client has no decision that depends on
 * them.
 */

import { NextResponse } from 'next/server';
import { musicianConfig } from '../config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const config = musicianConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { enabled: false, reachable: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const upstream = await fetch(`${config.baseUrl}/ready`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    // `/ready` returns 503 when a model is missing. That is "configured but not
    // able to work", which the UI shows differently from "not offered here".
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
