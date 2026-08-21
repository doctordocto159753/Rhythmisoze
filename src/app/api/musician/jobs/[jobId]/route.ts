/**
 * GET    /api/musician/jobs/:id — poll a generation.
 * DELETE /api/musician/jobs/:id — cancel it.
 *
 * The job id is validated against a strict pattern before it is placed in an
 * upstream URL. The service generates hex uuids, so anything else is either a
 * bug or an attempt to make this route fetch something it should not.
 */

import { NextResponse } from 'next/server';
import { musicianConfig } from '../../config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Exactly what `uuid4().hex` produces. Nothing else is a job id. */
const JOB_ID = /^[0-9a-f]{32}$/;

function disabled(): NextResponse {
  return NextResponse.json(
    { error: 'musician_disabled', detail: 'the musician service is not configured' },
    { status: 503 },
  );
}

async function proxy(jobId: string, method: 'GET' | 'DELETE'): Promise<NextResponse> {
  const config = musicianConfig();
  if (!config.enabled) return disabled();

  if (!JOB_ID.test(jobId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const controller = new AbortController();
  // Polling and cancelling are quick calls regardless of how long generation
  // takes, so they get a short timeout of their own rather than the generation
  // timeout — a poll that hangs for three minutes is a stuck UI.
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const upstream = await fetch(`${config.baseUrl}/v1/jobs/${jobId}`, {
      method,
      signal: controller.signal,
      cache: 'no-store',
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'musician_unavailable' }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await context.params;
  return proxy(jobId, 'GET');
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await context.params;
  return proxy(jobId, 'DELETE');
}
