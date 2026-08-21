/**
 * Published objects on Vercel Blob.
 *
 * The existing production path, preserved unchanged so `main` keeps deploying
 * exactly as it does today. This driver deliberately does not implement `put`:
 * in the Vercel flow the bytes never reach the server, and pretending otherwise
 * would invite a caller to route a 10 MB upload through a Function that cannot
 * accept one.
 */

import { del } from '@vercel/blob';
import { BLOB_TOKEN } from '@/server/config';
import type { StorageDriver, StoredObject, UploadPlan } from './index';

export function vercelBlobDriver(): StorageDriver {
  return {
    name: 'vercel-blob',

    isConfigured() {
      return BLOB_TOKEN.length > 0;
    },

    uploadPlan(): UploadPlan {
      return { kind: 'token', uploadUrl: '/api/publish/blob' };
    },

    async put(): Promise<StoredObject> {
      throw new Error(
        'the vercel-blob driver never receives bytes: clients upload directly with a scoped token',
      );
    },

    async remove(url) {
      try {
        await del(url, { token: BLOB_TOKEN });
      } catch {
        // Already deleted, or never existed. Both are the desired end state.
      }
    },

    publicUrl(key) {
      // Vercel returns the canonical URL at upload time; this is only used for
      // prefix checks, never to construct a URL a client will follow.
      return key;
    },

    owns(url) {
      return /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url);
    },
  };
}
