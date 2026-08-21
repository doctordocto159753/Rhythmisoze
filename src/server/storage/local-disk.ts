/**
 * Published objects on a persistent volume.
 *
 * The self-hosted default. No cloud account, no token, no egress bill: bytes
 * land in a directory that a Docker volume keeps across container recreation,
 * and are served back by `/api/objects/[...key]`.
 *
 * ## Why files are served by a route rather than by the reverse proxy
 *
 * Caddy could serve the directory directly and would be marginally faster. It
 * would also mean the proxy config and the app had to agree on a path layout
 * forever, and that a misconfigured proxy silently exposes the whole volume.
 * A route keeps one owner for the rule "only published objects are readable",
 * and the files are small and cached.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { SITE_URL } from '@/server/config';
import type { StorageDriver, StoredObject, UploadPlan } from './index';

/** Where objects live inside the container; a volume is mounted here. */
export const OBJECT_ROOT = resolve(process.env.STORAGE_LOCAL_PATH ?? '/data/objects');

/** Public path prefix. Kept distinct from `/api/publish` so it can be cached. */
const PUBLIC_PREFIX = '/api/objects';

/**
 * Refuse any key that could escape the object root.
 *
 * The key reaches this function from a signed ticket, so it is already
 * constrained -- but "already validated upstream" is exactly the assumption
 * that makes a path traversal possible when an upstream check is later
 * loosened. The check is cheap and it is the last line.
 */
export function safeObjectPath(key: string): string {
  const cleaned = normalize(key).replace(/^(\.\.(\/|\|$))+/, '');
  const full = resolve(join(OBJECT_ROOT, cleaned));
  if (full !== OBJECT_ROOT && !full.startsWith(OBJECT_ROOT + sep)) {
    throw new Error('object key escapes the storage root');
  }
  return full;
}

export function localDiskDriver(): StorageDriver {
  return {
    name: 'local-disk',

    isConfigured() {
      // A directory is all it needs, and it is created on first write.
      return true;
    },

    uploadPlan(): UploadPlan {
      return { kind: 'direct', uploadUrl: '/api/publish/upload' };
    },

    async put(key, data, contentType): Promise<StoredObject> {
      const target = safeObjectPath(key);
      await mkdir(dirname(target), { recursive: true });
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await writeFile(target, bytes);
      return {
        key,
        url: this.publicUrl(key),
        bytes: bytes.byteLength,
        contentType,
      };
    },

    async remove(url) {
      if (!this.owns(url)) return;
      const key = url.slice(`${SITE_URL}${PUBLIC_PREFIX}/`.length);
      try {
        await rm(safeObjectPath(key), { force: true });
      } catch {
        // Already gone is the desired end state, not an error to report.
      }
    },

    publicUrl(key) {
      return `${SITE_URL}${PUBLIC_PREFIX}/${key}`;
    },

    owns(url) {
      return url.startsWith(`${SITE_URL}${PUBLIC_PREFIX}/`);
    },
  };
}

/** Stable etag for a stored object, so the serving route can send 304s. */
export function objectEtag(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
}
