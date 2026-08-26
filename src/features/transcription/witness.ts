'use client';

/**
 * Whether this deployment has a second opinion about register available.
 *
 * Two consumers, and they want the same fact for different reasons:
 *
 *  - the transcription client, so it knows whether to tell the worker there is
 *    somewhere to send the take;
 *  - the record screen, so it can say what happens to a recording *before* one
 *    is made rather than after.
 *
 * The second is the reason this is a shared module rather than a detail of the
 * client. The product's standing promise is that recordings are processed on the
 * device, and when this service is on that stops being true. A promise the
 * interface makes has to come from the same place as the behaviour it describes,
 * or the two drift and the copy becomes the lie.
 */

import { useEffect, useState } from 'react';

export const WITNESS_STATUS_URL = '/api/transcription/status';
export const WITNESS_URL = '/api/transcription/witness';

export interface WitnessAvailability {
  /** The operator has configured a service. */
  enabled: boolean;
  /** It is configured *and* answering, which is what decides whether to ask. */
  available: boolean;
  /** False until the first check has settled. */
  checked: boolean;
}

const UNKNOWN: WitnessAvailability = { enabled: false, available: false, checked: false };

/**
 * The check, made once per page and shared.
 *
 * Cached because the answer cannot change while a page is open — it is
 * deployment configuration — and because the record screen and the transcription
 * client would otherwise ask separately and could briefly disagree.
 */
let inFlight: Promise<WitnessAvailability> | null = null;

export async function witnessAvailability(
  fetchImpl: typeof fetch | undefined = undefined,
): Promise<WitnessAvailability> {
  const run = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!run) return { ...UNKNOWN, checked: true };
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    try {
      const response = await run(WITNESS_STATUS_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body: unknown = await response.json();
      const read = (key: 'enabled' | 'reachable'): boolean =>
        typeof body === 'object' && body !== null && (body as Record<string, unknown>)[key] === true;
      const enabled = read('enabled');
      return { enabled, available: enabled && read('reachable'), checked: true };
    } catch {
      // Unreachable, unconfigured, or an app with no such route. All of them
      // mean the same thing: there is no second opinion here.
      return { enabled: false, available: false, checked: true };
    }
  })();

  return inFlight;
}

/** Test seam. The cache is process-wide and would otherwise leak between cases. */
export function resetWitnessAvailability(): void {
  inFlight = null;
}

export function useWitnessAvailability(
  fetchImpl: typeof fetch | undefined = undefined,
): WitnessAvailability {
  const [state, setState] = useState<WitnessAvailability>(UNKNOWN);

  useEffect(() => {
    let cancelled = false;
    void witnessAvailability(fetchImpl).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  return state;
}
