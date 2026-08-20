import 'server-only';

/**
 * Server configuration.
 *
 * Every secret is read here and nowhere else, so a `grep` for `process.env` in
 * `src/features` or `src/app` returning a secret name is a review failure
 * (Playbook 16: "secrets server-only").
 *
 * The whole publish subsystem is optional. A deployment with no storage token
 * and no database still serves the complete local creation experience -
 * record, transcribe, retouch, render, export - and simply hides publishing.
 * That is deliberate: the product's core promise does not depend on a backend,
 * and the code should make that impossible to forget.
 */

export const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN ?? '';
export const DATABASE_URL = process.env.DATABASE_URL ?? '';

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

/**
 * Q-C3 - published assets are retained after deletion rather than purged at once.
 *
 * Caveat recorded here because it is a real limitation rather than a choice:
 * the object store serves public URLs, so during the retention window the raw
 * asset URL remains reachable by anyone who already has it. What deletion does
 * immediately is tombstone the record, which takes the share page, the OG image
 * and the API out of service. The objects themselves are removed by the purge
 * job after this many days. See `docs/runbooks/publish-retention.md`.
 */
export const PURGE_DELETED_AFTER_DAYS = Number(process.env.PURGE_DELETED_AFTER_DAYS ?? '30');

/** Shared secret for the maintenance purge endpoint. Empty disables it. */
export const MAINTENANCE_TOKEN = process.env.MAINTENANCE_TOKEN ?? '';

/** PRD R-05 and US-1008: sixty seconds, enforced server-side too. */
export const MAX_PUBLISH_DURATION_SEC = 60;
/** A 60 s stereo 16-bit WAV at 44.1 kHz is ~10.6 MB; 16 MB leaves headroom. */
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_MIDI_BYTES = 512 * 1024;
export const MAX_TITLE_LENGTH = 80;

export function isPublishConfigured(): boolean {
  return BLOB_TOKEN !== '' && DATABASE_URL !== '';
}
