/**
 * US-1101..US-1103 - product and performance telemetry.
 *
 * ## What this never sends
 *
 * Audio, note data, titles, and anything derived from the content of a
 * recording. The event list below is exhaustive and the property values are
 * numbers and short enumerated strings. That is not a policy statement here, it
 * is the shape of the code: `EventProperties` cannot hold a blob or an array.
 *
 * ## Where it goes
 *
 * Nowhere, unless `NEXT_PUBLIC_ANALYTICS_ENDPOINT` is set. The default build
 * collects nothing at all, which keeps the privacy claim on the landing page
 * true for a self-hosted deployment without any configuration.
 *
 * ## Why failures are swallowed here
 *
 * Playbook 23 says never swallow errors - and this is the one documented
 * exception, required by US-1102: "analytics failures never block creation".
 * A blocked request, an ad blocker or an offline device must not surface an
 * error in the middle of a take. The failure is counted so a developer can see
 * it in the console in development.
 */

export type AnalyticsEvent =
  | 'landing_viewed'
  | 'tempo_set'
  | 'mode_selected'
  | 'recording_started'
  | 'recording_completed'
  | 'processing_started'
  | 'processing_completed'
  | 'retouch_changed'
  | 'instrument_previewed'
  | 'instrument_selected'
  | 'render_started'
  | 'render_completed'
  | 'download_wav'
  | 'download_midi'
  | 'publish_started'
  | 'publish_completed'
  | 'share_viewed'
  | 'try_it_clicked'
  | 'workspace_opened'
  | 'error';

/** Deliberately narrow: no nested objects, no arrays, no free text. */
export type EventProperties = Record<string, string | number | boolean>;

const ENDPOINT = process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT ?? '';

/** Coarse device class. Never a fingerprint - four buckets, nothing more. */
function deviceClass(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 0;
  if (memory !== undefined && memory <= 4) return 'low';
  if (cores <= 4) return 'low';
  if (cores <= 8) return 'mid';
  return 'high';
}

let failures = 0;

export function track(event: AnalyticsEvent, properties: EventProperties = {}): void {
  if (typeof window === 'undefined') return;
  if (ENDPOINT === '') return;

  const body = JSON.stringify({
    event,
    properties: { ...properties, device: deviceClass() },
    locale: document.documentElement.lang || 'unknown',
    at: Date.now(),
  });

  try {
    // `sendBeacon` survives the page being closed, which matters for the last
    // event in a funnel. It also cannot be awaited, which is the right shape:
    // nothing in the creation flow should ever wait on telemetry.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(ENDPOINT, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      keepalive: true,
    }).catch(() => {
      failures += 1;
    });
  } catch {
    failures += 1;
    if (process.env.NODE_ENV === 'development' && failures === 1) {
      console.warn('[analytics] delivery failed; creation is unaffected');
    }
  }
}

/** US-1103 - a timing sample, rounded so it cannot become an identifier. */
export function trackTiming(
  event: Extract<AnalyticsEvent, 'processing_completed' | 'render_completed'>,
  milliseconds: number,
  properties: EventProperties = {},
): void {
  track(event, { ...properties, ms: Math.round(milliseconds / 50) * 50 });
}
