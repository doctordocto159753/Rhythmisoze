/**
 * Register-witness service configuration, server-side only.
 *
 * The reasoning is the Musician's, and for the same two reasons: the service is
 * on a private network, and publishing its address would turn an unauthenticated
 * internal endpoint into a public inference endpoint by accident. So the browser
 * talks to `/api/transcription/*` and never learns where this is.
 *
 * ## Off is the normal state
 *
 * Two independent reasons, and the second is the important one.
 *
 * The service is optional in the ordinary sense: not every deployment stands it
 * up, and the product is complete without it — the register arbitration needs
 * two agreeing witnesses, so with only the browser's own engine it reports
 * disagreements instead of acting on them, and every other stage is byte for
 * byte what it was.
 *
 * It is also optional in a sense the Musician is not. Asking it a question means
 * **sending the user's recording off their machine**, and the product's standing
 * promise is that recordings are processed on the device. Turning this on
 * changes that promise, and changing a promise on a user's behalf is not a
 * default anyone should inherit from a config file they did not read. The
 * interface says which of the two is true; this flag decides which.
 *
 * GAME's weights are also CC BY-NC-SA 4.0 while Rhythmisoze is MIT, so a
 * deployment that enables this is a non-commercial one. See
 * `models/manifest.json`.
 */

export interface TranscriptionConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * Default deadline for one witness request.
 *
 * A ten-second take measured about seven seconds on a CPU-only machine, most of
 * it process start and model load. Thirty gives a sixty-second take room without
 * turning "the service is wedged" into a minute of staring at a spinner — and
 * the caller treats a timeout as "no second opinion", not as a failure.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

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
