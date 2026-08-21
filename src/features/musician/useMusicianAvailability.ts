'use client';

/**
 * Is the Musician offered by this deployment?
 *
 * The browser cannot read `MUSICIAN_ENABLED` — server configuration in a bundle
 * is how a service URL leaks — so it asks the app's own status route, which
 * answers with a boolean and nothing else.
 *
 * ## Why it starts as unavailable
 *
 * The initial value is `false`, not "unknown", and the panel renders nothing
 * until the answer arrives. Showing a "Create musician versions" button that
 * might vanish a moment later is worse than showing it a moment late: the
 * button is not the point of the screen, and a control that appears and
 * disappears under the cursor is a real usability failure rather than a
 * cosmetic one.
 *
 * ## Why a failed check means unavailable
 *
 * If the status route cannot be reached, the app is in no position to offer a
 * feature that depends on reaching a service *through* that route. Failing
 * closed here costs a user nothing — they keep all three local versions — and
 * failing open would offer a button that cannot work.
 */

import { useEffect, useState } from 'react';

export interface MusicianAvailability {
  /** Configured for this deployment. */
  enabled: boolean;
  /** Configured *and* the service answered. */
  available: boolean;
  /** False until the first answer arrives. */
  checked: boolean;
}

const UNKNOWN: MusicianAvailability = { enabled: false, available: false, checked: false };

export function useMusicianAvailability(
  fetchImpl: typeof fetch | undefined = undefined,
): MusicianAvailability {
  const [state, setState] = useState<MusicianAvailability>(UNKNOWN);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const run = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!run) return;

    void (async () => {
      try {
        const response = await run('/api/musician/status', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const body: unknown = await response.json();
        if (cancelled) return;
        const enabled =
          typeof body === 'object' && body !== null && (body as { enabled?: unknown }).enabled === true;
        const reachable =
          typeof body === 'object' &&
          body !== null &&
          (body as { reachable?: unknown }).reachable === true;
        setState({ enabled, available: enabled && reachable, checked: true });
      } catch {
        if (!cancelled) setState({ enabled: false, available: false, checked: true });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchImpl]);

  return state;
}
