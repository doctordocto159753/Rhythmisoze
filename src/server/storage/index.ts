/**
 * Published-object storage, behind one seam.
 *
 * Publishing was written against Vercel Blob, and the shape of that API leaked
 * into the routes: the client asks for a scoped token and uploads *directly* to
 * the store, because a Vercel Function cannot accept a 10 MB body. That is a
 * good design for Vercel and a strange one for a single Linux box, where the
 * app can simply receive the file.
 *
 * So the seam is deliberately narrow, and it is not "wrap the Vercel API".
 * It is the two questions publishing actually asks:
 *
 *   1. how does a client get bytes into the store?
 *   2. what URL will those bytes be readable at afterwards?
 *
 * A driver answers both. Vercel answers (1) with a token and a direct upload;
 * local disk answers it with an ordinary POST to this app. Neither is emulated
 * in terms of the other, because emulating direct-upload on disk would mean
 * inventing a token system nobody needs, and emulating a POST on Vercel would
 * reintroduce the body limit the token flow exists to avoid.
 *
 * ## Why local disk is the default for self-hosting
 *
 * The brief asks for the cheapest single-server deployment to work with no
 * cloud account at all. A persistent volume is that. The S3 seam is left open —
 * `StorageDriver` is the whole contract, and an S3 driver is a third file — but
 * it is not written speculatively, because an untested adapter for a service
 * nobody has configured is not an abstraction, it is a liability.
 */

export type StorageDriverName = 'vercel-blob' | 'local-disk';

export interface StoredObject {
  /** Path within the store, e.g. `sketches/abc123/audio.wav`. */
  key: string;
  /** Absolute URL a browser can read the object from. */
  url: string;
  bytes: number;
  contentType: string;
}

/**
 * How a client is told to upload.
 *
 * `direct` means "POST the bytes to this app at `uploadUrl`". `token` means
 * "ask the store for a token and upload there", which is the Vercel flow and
 * needs the client SDK.
 */
export interface UploadPlan {
  kind: 'direct' | 'token';
  uploadUrl: string;
}

export interface StorageDriver {
  readonly name: StorageDriverName;

  /** Whether this driver has everything it needs to work. */
  isConfigured(): boolean;

  /** How this deployment's clients should send bytes. */
  uploadPlan(): UploadPlan;

  /**
   * Store bytes that have already reached the server.
   *
   * Only meaningful for `direct` drivers; a token driver never sees the bytes,
   * and says so rather than pretending to store them.
   */
  put(key: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<StoredObject>;

  /** Remove an object. Must not throw when it is already absent. */
  remove(url: string): Promise<void>;

  /** The public URL an object key will be readable at. */
  publicUrl(key: string): string;

  /** Whether a URL belongs to this store, used to validate delete requests. */
  owns(url: string): boolean;
}

let cached: StorageDriver | null = null;

/**
 * The driver for this deployment.
 *
 * Chosen from `STORAGE_DRIVER`, defaulting to local disk. The default matters:
 * a self-hosted operator who sets nothing should get the working local path
 * rather than a Vercel driver that fails for want of a token they will never
 * have.
 */
export function storage(): StorageDriver {
  if (cached) return cached;

  const requested = (process.env.STORAGE_DRIVER ?? '').trim().toLowerCase();
  // An explicit Vercel token with no driver set is the Vercel deployment, and
  // it must keep working unchanged -- `main` is still deployed that way.
  const inferred =
    requested || (process.env.BLOB_READ_WRITE_TOKEN ? 'vercel-blob' : 'local-disk');

  if (inferred === 'vercel-blob') {
    // Loaded lazily so a self-hosted image never has to resolve the Vercel SDK.
    const { vercelBlobDriver } = require('./vercel-blob') as typeof import('./vercel-blob');
    cached = vercelBlobDriver();
  } else {
    const { localDiskDriver } = require('./local-disk') as typeof import('./local-disk');
    cached = localDiskDriver();
  }
  return cached;
}

/** Test seam; also used when configuration changes between requests in dev. */
export function resetStorageForTests(): void {
  cached = null;
}
