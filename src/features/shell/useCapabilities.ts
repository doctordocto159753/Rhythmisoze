'use client';

import { useSyncExternalStore } from 'react';
import {
  assessCoreSupport,
  assessPerformanceTier,
  detectCapabilities,
  type Capabilities,
  type PerformanceTier,
} from '@audio-core';

/**
 * Browser capabilities as external state.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`. The capability
 * set genuinely *is* external state - it belongs to the browser, not to React -
 * and two of its inputs change while the page is open: `prefers-reduced-motion`
 * and `pointer: coarse` both fire media-query events when the user changes a
 * system setting or plugs in a mouse.
 *
 * This also gives a correct server snapshot, so the first client render matches
 * the server HTML instead of hydrating and then flipping.
 */

let cached: Capabilities | null = null;
const listeners = new Set<() => void>();

/** A stable server snapshot: nothing is available until the client says so. */
const SERVER_SNAPSHOT: Capabilities = Object.freeze(detectCapabilities());

function subscribe(callback: () => void): () => void {
  listeners.add(callback);

  const queries =
    typeof window === 'undefined'
      ? []
      : [
          window.matchMedia('(prefers-reduced-motion: reduce)'),
          window.matchMedia('(pointer: coarse)'),
        ];

  const invalidate = (): void => {
    cached = null;
    for (const listener of listeners) listener();
  };

  for (const query of queries) query.addEventListener('change', invalidate);

  return () => {
    listeners.delete(callback);
    for (const query of queries) query.removeEventListener('change', invalidate);
  };
}

function getSnapshot(): Capabilities {
  // Cached so the snapshot is referentially stable between invalidations;
  // returning a fresh object every call makes React loop forever.
  if (cached === null) cached = detectCapabilities();
  return cached;
}

function getServerSnapshot(): Capabilities {
  return SERVER_SNAPSHOT;
}

export function useCapabilities(): Capabilities {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useCoreSupport(): ReturnType<typeof assessCoreSupport> {
  return assessCoreSupport(useCapabilities());
}

export function usePerformanceTier(): PerformanceTier {
  return assessPerformanceTier(useCapabilities());
}

/**
 * `true` once the component is running in the browser.
 *
 * Derived from the capability store rather than from a mount effect, so it does
 * not need its own `setState` on mount.
 */
export function useIsClient(): boolean {
  return useCapabilities() !== SERVER_SNAPSHOT;
}
