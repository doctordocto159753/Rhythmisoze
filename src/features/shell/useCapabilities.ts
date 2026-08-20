'use client';

import { useSyncExternalStore } from 'react';
import {
  assessCoreSupport,
  assessPerformanceTier,
  detectCapabilities,
  type Capabilities,
  type CoreSupport,
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
 * ## The rule this file exists to obey
 *
 * `getServerSnapshot` must return the *same value on the server and during
 * client hydration*. React calls it in both places, and if the two disagree the
 * result is a hydration mismatch on every single page load.
 *
 * That is exactly what an earlier version got wrong: the snapshot was computed
 * once at module scope, which runs in Node on the server (everything absent)
 * and in the browser on the client (everything present). The two never matched,
 * and React reported error #418 on every load.
 *
 * So the snapshot below is a hardcoded constant, not a measurement. It means
 * "nothing has been measured yet", which is the truth during prerender, and
 * `useIsMeasured()` is how a component knows to wait rather than to act on it.
 */

/**
 * The pre-measurement snapshot. Identical on the server and during hydration
 * because it is a literal, not a call. Never mutated; frozen so it cannot be.
 */
const UNMEASURED: Capabilities = Object.freeze({
  secureContext: false,
  microphone: false,
  webAudio: false,
  mediaRecorder: false,
  recordingMimeType: null,
  offlineAudio: false,
  webWorker: false,
  indexedDb: false,
  webAssembly: false,
  webgl2: false,
  cacheStorage: false,
  deviceMemoryGb: null,
  hardwareConcurrency: 1,
  prefersReducedMotion: false,
  coarsePointer: false,
});

let cached: Capabilities | null = null;
const listeners = new Set<() => void>();

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
  return UNMEASURED;
}

export function useCapabilities(): Capabilities {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * `false` until the browser has actually been measured.
 *
 * The distinction matters: before measurement the capability set is all-false,
 * and a component that treats that as a *result* will tell a perfectly capable
 * browser that it is unsupported — in server-rendered HTML, before any code has
 * looked at the browser at all.
 *
 * Implemented as its own store subscription rather than by comparing against
 * `UNMEASURED`, so it stays correct even if a real browser somehow produced an
 * equal snapshot.
 */
export function useIsMeasured(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export function useCoreSupport(): CoreSupport & { measured: boolean } {
  const measured = useIsMeasured();
  const capabilities = useCapabilities();
  return { ...assessCoreSupport(capabilities), measured };
}

export function usePerformanceTier(): PerformanceTier {
  return assessPerformanceTier(useCapabilities());
}
