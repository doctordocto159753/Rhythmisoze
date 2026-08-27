/**
 * Authoritative transcription service configuration, server-side only.
 *
 * The reasoning is the Musician's, and for the same two reasons: the service is
 * on a private network, and publishing its address would turn an unauthenticated
 * internal endpoint into a public inference endpoint by accident. So the browser
 * talks to `/api/transcription/*` and never learns where this is.
 *
 * The browser talks only to `/api/transcription/*`; it never learns the private
 * service address. Missing configuration is kept representable because the
 * correct behavior is an explanatory 503, never a browser-model fallback.
 */

export interface TranscriptionConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * Default deadline for one authoritative request.
 *
 * A ten-second take measured about seven seconds on a CPU-only machine, most of
 * it process start and model load. A sixty-second CPU request needs materially
 * more than the old witness timeout; the client remains cancellable throughout.
 */
const DEFAULT_TIMEOUT_MS = 180_000;

function readTimeout(): number {
  const raw = process.env.TRANSCRIPTION_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function transcriptionConfig(): TranscriptionConfig {
  const baseUrl = (process.env.TRANSCRIPTION_API_URL ?? '').trim().replace(/\/+$/, '');
  const flag = (process.env.TRANSCRIPTION_ENABLED ?? '').trim().toLowerCase();
  const enabled = flag === 'true' || flag === '1';
  return {
    // Both, for the same reason the Musician needs both: a deployment that sets
    // the flag and forgets the URL gets a clean "not configured" rather than
    // requests to a relative path that resolve back to this app.
    enabled: enabled && baseUrl.length > 0,
    baseUrl,
    timeoutMs: readTimeout(),
  };
}
