/**
 * GET /api/objects/<key> — serve a published object from the local volume.
 *
 * Only used by the `local-disk` driver. On Vercel the objects are served by the
 * blob store and this route is never reached.
 *
 * Two things it refuses to do:
 *
 *  - **serve anything outside the object root**, enforced by `safeObjectPath`
 *    rather than by trusting the router's parameter parsing;
 *  - **guess a content type from the bytes.** Only the two extensions
 *    publishing actually creates are served, each with a fixed type. A store
 *    that will serve arbitrary types is a store that can host an HTML page on
 *    your origin.
 */

import { readFile, stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { objectEtag, safeObjectPath } from '@/server/storage/local-disk';
import { storage } from '@/server/storage';

export const runtime = 'nodejs';

/** Publishing writes exactly these two files. Nothing else is served. */
const CONTENT_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mid': 'audio/midi',
};

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  if (storage().name !== 'local-disk') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const { key } = await context.params;
  const joined = key.join('/');
  const extension = joined.slice(joined.lastIndexOf('.')).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let path: string;
  try {
    path = safeObjectPath(joined);
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    const bytes = await readFile(path);
    const etag = objectEtag(bytes);

    if (request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { etag } });
    }

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': contentType,
        'content-length': String(info.size),
        etag,
        // Published objects are immutable: a sketch's audio never changes
        // under the same id, so this can be cached hard.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
