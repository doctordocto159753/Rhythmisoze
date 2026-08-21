/**
 * Musician service configuration, server-side only.
 *
 * ## Why there is a proxy at all
 *
 * The browser must never learn the service URL. Two reasons, and the second is
 * the one that matters:
 *
 *  1. the service is typically on a private network, so a browser could not
 *     reach it anyway;
 *  2. if the URL were public, the service would become a public endpoint by
 *     accident — it has no authentication, because it was designed on the
 *     assumption that only the app can call it. Publishing the address turns a
 *     reasonable internal design into an open inference endpoint.
 *
 * So this module is not exported to any client component, and the routes that
 * use it are the only thing the browser talks to.
 *
 * ## Disabled is a first-class state
 *
 * `MUSICIAN_ENABLED=false`, or simply no URL configured, is the normal state
 * for a deployment that has not stood the service up. The product is fully
 * functional there: three versions, unchanged behaviour, and the Musician area
 * is not shown at all. That is AC-01, and it is why `isMusicianEnabled()`
 * returns false rather than throwing when unconfigured.
 */

export interface MusicianConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function readTimeout(): number {
  const raw = process.env.MUSICIAN_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  // A nonsense value falls back rather than producing a zero timeout that makes
  // every request fail instantly and look like the service is down.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function musicianConfig(): MusicianConfig {
  const baseUrl = (process.env.MUSICIAN_API_URL ?? '').trim().replace(/\/+$/, '');
  // Enabled requires both the flag and an actual address. A deployment that
  // sets the flag and forgets the URL gets a clean "not configured" rather than
  // requests to a relative path that resolve back to this app.
  const flag = (process.env.MUSICIAN_ENABLED ?? '').trim().toLowerCase();
  const enabled = flag === 'true' || flag === '1';
  return {
    enabled: enabled && baseUrl.length > 0,
    baseUrl,
    timeoutMs: readTimeout(),
  };
}

export function isMusicianEnabled(): boolean {
  return musicianConfig().enabled;
}
