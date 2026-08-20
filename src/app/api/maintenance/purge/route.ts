import { del } from '@vercel/blob';
import { NextResponse } from 'next/server';
import {
  BLOB_TOKEN,
  isPublishConfigured,
  MAINTENANCE_TOKEN,
  PURGE_DELETED_AFTER_DAYS,
} from '@/server/config';
import { findPurgeable, markPurged } from '@/server/db';

/**
 * Q-C3 - the retention purge.
 *
 * Deletion tombstones the record immediately; the objects themselves survive
 * for `PURGE_DELETED_AFTER_DAYS` so an accidental delete can be recovered
 * operationally. This route removes the ones whose window has closed.
 *
 * It is a pull endpoint rather than a background worker so it can be driven by
 * a scheduled job on any platform. It requires `MAINTENANCE_TOKEN`; if that is
 * unset the route refuses to run at all, rather than defaulting to open.
 *
 * See `docs/runbooks/publish-retention.md`, including the stated limitation
 * that a retained object's URL remains technically reachable during the window.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'publishing_disabled' }, { status: 503 });
  }
  if (MAINTENANCE_TOKEN === '') {
    return NextResponse.json({ error: 'maintenance_disabled' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${MAINTENANCE_TOKEN}`) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const rows = await findPurgeable(100);
  let purged = 0;
  const failures: string[] = [];

  for (const row of rows) {
    try {
      // Both objects go together. A half-purged sketch would leave the audio
      // reachable while the MIDI was gone, which is the worst of both.
      await del([row.audio_url, row.midi_url].filter(Boolean), { token: BLOB_TOKEN });
      await markPurged(row.id);
      purged += 1;
    } catch {
      // Recorded and skipped: one unreachable object must not stop the batch,
      // and the next run will retry it.
      failures.push(row.id);
    }
  }

  return NextResponse.json({
    scanned: rows.length,
    purged,
    failures,
    retentionDays: PURGE_DELETED_AFTER_DAYS,
  });
}
