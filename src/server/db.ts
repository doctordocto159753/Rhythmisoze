import 'server-only';

import postgres from 'postgres';
import type { CreationMode, PublishedSketch } from '@contracts';
import { DATABASE_URL, PURGE_DELETED_AFTER_DAYS } from './config';

/**
 * US-1002 / US-1004 - published metadata.
 *
 * PostgreSQL through a Marketplace provider, Neon by default (see the package
 * README's 2026 correction: Vercel Postgres is no longer a standalone product).
 * The driver is the plain `postgres` client rather than an ORM: this schema is
 * one table and four queries, and an ORM would add a build step, a migration
 * runtime and a set of generated types for no benefit at this size.
 *
 * Migrations live in `migrations/` and are applied by `npm run db:migrate`,
 * which is idempotent and safe to re-run (US-1302).
 */

let client: ReturnType<typeof postgres> | null = null;

function sql(): ReturnType<typeof postgres> {
  if (DATABASE_URL === '') throw new Error('DATABASE_URL is not configured');
  if (client === null) {
    client = postgres(DATABASE_URL, {
      // Serverless functions are short-lived; a large pool per instance just
      // exhausts the database's connection limit under load.
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return client;
}

export interface PublishedRow {
  id: string;
  title: string;
  bpm: number;
  mode: CreationMode;
  key_root: string | null;
  key_mode: string | null;
  instrument_id: string;
  audio_key: string;
  audio_url: string;
  midi_key: string;
  midi_url: string;
  duration_sec: number;
  locale: string;
  manage_token_hash: string;
  created_at: Date;
  deleted_at: Date | null;
  play_count: number;
  schema_version: number;
}

export interface CreateInput {
  id: string;
  title: string;
  bpm: number;
  mode: CreationMode;
  keyRoot: string | null;
  keyMode: string | null;
  instrumentId: string;
  audioKey: string;
  audioUrl: string;
  midiKey: string;
  midiUrl: string;
  durationSec: number;
  locale: string;
  manageTokenHash: string;
}

export async function createPublished(input: CreateInput): Promise<void> {
  const db = sql();
  await db`
    INSERT INTO published_sketches (
      id, title, bpm, mode, key_root, key_mode, instrument_id,
      audio_key, audio_url, midi_key, midi_url, duration_sec, locale,
      manage_token_hash, schema_version
    ) VALUES (
      ${input.id}, ${input.title}, ${input.bpm}, ${input.mode},
      ${input.keyRoot}, ${input.keyMode}, ${input.instrumentId},
      ${input.audioKey}, ${input.audioUrl}, ${input.midiKey}, ${input.midiUrl},
      ${input.durationSec}, ${input.locale}, ${input.manageTokenHash}, 1
    )
    -- Publish is duplicate-safe: a retried request with the same id is a
    -- no-op rather than a constraint violation (US-1004).
    ON CONFLICT (id) DO NOTHING
  `;
}

export async function findPublished(id: string): Promise<PublishedRow | null> {
  const db = sql();
  const rows = await db<PublishedRow[]>`
    SELECT * FROM published_sketches WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Includes tombstoned rows. Used only by the delete path and the purge job. */
export async function findAny(id: string): Promise<PublishedRow | null> {
  const db = sql();
  const rows = await db<PublishedRow[]>`
    SELECT * FROM published_sketches WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * US-1007 - tombstone rather than hard delete.
 *
 * Returns `false` when nothing was deleted, which happens when the row is
 * already gone. Callers must not distinguish "wrong token" from "already
 * deleted" in what they return to the client: doing so turns this endpoint
 * into an oracle for which ids exist.
 */
export async function softDelete(id: string): Promise<boolean> {
  const db = sql();
  const rows = await db`
    UPDATE published_sketches
    SET deleted_at = NOW()
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

export async function incrementPlayCount(id: string): Promise<void> {
  const db = sql();
  await db`UPDATE published_sketches SET play_count = play_count + 1 WHERE id = ${id}`;
}

/** Rows whose retention window has expired and whose objects can be removed. */
export async function findPurgeable(limit = 100): Promise<PublishedRow[]> {
  const db = sql();
  return db<PublishedRow[]>`
    SELECT * FROM published_sketches
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - (${PURGE_DELETED_AFTER_DAYS} * INTERVAL '1 day')
      AND audio_key <> ''
    ORDER BY deleted_at ASC
    LIMIT ${limit}
  `;
}

/** Marks a purged row so the job does not revisit it. Keeps the tombstone. */
export async function markPurged(id: string): Promise<void> {
  const db = sql();
  await db`
    UPDATE published_sketches
    SET audio_key = '', midi_key = '', audio_url = '', midi_url = ''
    WHERE id = ${id}
  `;
}

/** Maps a row to the public shape. Never exposes the token hash or the keys. */
export function toPublicSketch(row: PublishedRow): PublishedSketch {
  return {
    id: row.id,
    title: row.title,
    bpm: row.bpm,
    mode: row.mode,
    keyRoot: (row.key_root as PublishedSketch['keyRoot']) ?? null,
    keyMode: (row.key_mode as PublishedSketch['keyMode']) ?? null,
    instrumentId: row.instrument_id,
    audioUrl: row.audio_url,
    midiUrl: row.midi_url,
    durationSec: Number(row.duration_sec),
    createdAt: row.created_at.toISOString(),
    playCount: row.play_count,
    schemaVersion: row.schema_version,
  };
}
