/**
 * US-0801..US-0805 - the local workspace.
 *
 * Sketches live in IndexedDB and nowhere else until the user publishes. No
 * account, no sync, no server round trip - that is the product's privacy claim
 * made structural rather than promised (PRD 8, Playbook 16).
 *
 * Two design decisions worth stating:
 *
 *  1. **Blobs are a separate table.** A sketch row is a few kilobytes of note
 *     data; a rendered WAV is megabytes. Splitting them lets the workspace list
 *     load without pulling audio into memory, and lets audio be evicted under
 *     quota pressure while the notes - the part that cannot be regenerated -
 *     survive (US-0805).
 *  2. **Quota failures are classified, never swallowed.** Running out of space
 *     is the most common way a local-first app loses work, so it gets its own
 *     error code and its own recovery action.
 */

import Dexie, { type Table } from 'dexie';
import {
  AppError,
  LOCAL_SCHEMA_VERSION,
  type LocalSketch,
  type LocalSourceAsset,
} from '@contracts';

/** The row as stored: blobs are held elsewhere and referenced by id. */
export interface StoredSketch extends Omit<LocalSketch, 'renderedAudio' | 'midi' | 'source'> {
  hasAudio: boolean;
  hasMidi: boolean;
  hasSource: boolean;
  sourceDescriptor?: Omit<LocalSourceAsset, 'blob'>;
}

export interface StoredBlob {
  /** `${sketchId}:audio`, `${sketchId}:midi` or `${sketchId}:source`. */
  key: string;
  sketchId: string;
  blob: Blob;
  bytes: number;
  updatedAt: number;
}

class WorkspaceDatabase extends Dexie {
  sketches!: Table<StoredSketch, string>;
  blobs!: Table<StoredBlob, string>;

  constructor() {
    super('rhythmisoze');
    this.version(1).stores({
      sketches: 'id, updatedAt, createdAt, mode, publishedId',
      blobs: 'key, sketchId, updatedAt',
    });

    /**
     * Version 2 -> 3: the Musician versions.
     *
     * The indexes do not change, because nothing is queried by the new fields.
     * Declaring the version is still necessary so Dexie runs the upgrade and
     * older rows get re-stamped rather than being read back with a stale
     * `schemaVersion` forever.
     *
     * The upgrade is additive by construction: every field version 3 adds is
     * optional, so an existing row is already valid and the callback only
     * updates the stamp. A migration that reshapes rows is a migration that can
     * lose them, and there is no server copy of this data to restore from
     * (AC-08).
     */
    this.version(3)
      .stores({
        sketches: 'id, updatedAt, createdAt, mode, publishedId',
        blobs: 'key, sketchId, updatedAt',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table<StoredSketch, string>('sketches')
          .toCollection()
          .modify((row) => {
            // Deliberately does not touch notes, blobs, retouch settings or
            // any other field. Nothing about an older sketch is wrong; it
            // simply predates a feature.
            row.schemaVersion = LOCAL_SCHEMA_VERSION;
          });
      });
  }
}

let database: WorkspaceDatabase | null = null;

function db(): WorkspaceDatabase {
  if (typeof indexedDB === 'undefined') {
    throw new AppError('storage_unavailable', 'none', 'no indexedDB');
  }
  if (database === null) database = new WorkspaceDatabase();
  return database;
}

/** Maps a Dexie/DOM failure to a typed error the UI can act on. */
function toStorageError(error: unknown): AppError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new AppError('storage_quota_exceeded', 'free_space', name, { cause: error });
  }
  if (name === 'InvalidStateError' || name === 'SecurityError') {
    // Private browsing and blocked-storage settings land here.
    return new AppError('storage_unavailable', 'none', name, { cause: error });
  }
  return new AppError('storage_failed', 'retry', name || 'unknown', { cause: error });
}

export function newSketchId(): string {
  // 12 chars of base36 from crypto - enough that a user with thousands of local
  // sketches will not collide, and not derived from a clock.
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}

export async function listSketches(): Promise<StoredSketch[]> {
  try {
    return await db().sketches.orderBy('updatedAt').reverse().toArray();
  } catch (error) {
    throw toStorageError(error);
  }
}

export async function getSketch(id: string): Promise<LocalSketch | undefined> {
  try {
    const row = await db().sketches.get(id);
    if (!row) return undefined;
    const [audio, midi, source] = await Promise.all([
      row.hasAudio ? db().blobs.get(`${id}:audio`) : undefined,
      row.hasMidi ? db().blobs.get(`${id}:midi`) : undefined,
      row.hasSource ? db().blobs.get(`${id}:source`) : undefined,
    ]);
    const {
      hasAudio: _a,
      hasMidi: _m,
      hasSource: _s,
      sourceDescriptor,
      ...rest
    } = row;
    return {
      ...rest,
      renderedAudio: audio?.blob,
      midi: midi?.blob,
      source:
        source?.blob && sourceDescriptor
          ? { ...sourceDescriptor, blob: source.blob }
          : undefined,
    };
  } catch (error) {
    throw toStorageError(error);
  }
}

export interface SaveResult {
  /** `true` when the notes were saved but the audio had to be dropped. */
  audioDropped: boolean;
  /** The current session still owns the source even if persistence ran out. */
  sourceDropped: boolean;
}

/**
 * US-0802 - save a sketch.
 *
 * The note data is written first and committed on its own. Only then is the
 * rendered audio attempted, and a quota failure on the audio is caught and
 * reported rather than rolled back. Losing a cached render is an inconvenience;
 * losing the transcription is losing the user's idea.
 */
export async function saveSketch(sketch: LocalSketch): Promise<SaveResult> {
  const row: StoredSketch = {
    id: sketch.id,
    title: sketch.title,
    locale: sketch.locale,
    bpm: sketch.bpm,
    meter: sketch.meter,
    mode: sketch.mode,
    instrumentId: sketch.instrumentId,
    retouch: sketch.retouch,
    rawNotes: sketch.rawNotes,
    phraseModel: sketch.phraseModel,
    rawDrums: sketch.rawDrums,
    analysis: sketch.analysis,
    durationSec: sketch.durationSec,
    createdAt: sketch.createdAt,
    updatedAt: Date.now(),
    publishedId: sketch.publishedId,
    schemaVersion: LOCAL_SCHEMA_VERSION,
    musician: sketch.musician,
    selectedVersionId: sketch.selectedVersionId,
    hasAudio: sketch.renderedAudio !== undefined,
    hasMidi: sketch.midi !== undefined,
    hasSource: sketch.source !== undefined,
    sourceDescriptor: sketch.source
      ? {
          kind: sketch.source.kind,
          filename: sketch.source.filename,
          mimeType: sketch.source.mimeType,
        }
      : undefined,
  };

  try {
    await db().sketches.put(row);
  } catch (error) {
    throw toStorageError(error);
  }

  let sourceDropped = false;
  if (sketch.source) {
    try {
      await db().blobs.put({
        key: `${sketch.id}:source`,
        sketchId: sketch.id,
        blob: sketch.source.blob,
        bytes: sketch.source.blob.size,
        updatedAt: row.updatedAt,
      });
    } catch (error) {
      const mapped = toStorageError(error);
      if (mapped.code !== 'storage_quota_exceeded') throw mapped;
      sourceDropped = true;
      await db().sketches.update(sketch.id, { hasSource: false }).catch(() => undefined);
    }
  }

  let audioDropped = false;
  try {
    const writes: StoredBlob[] = [];
    if (sketch.midi) {
      writes.push({
        key: `${sketch.id}:midi`,
        sketchId: sketch.id,
        blob: sketch.midi,
        bytes: sketch.midi.size,
        updatedAt: row.updatedAt,
      });
    }
    if (sketch.renderedAudio) {
      writes.push({
        key: `${sketch.id}:audio`,
        sketchId: sketch.id,
        blob: sketch.renderedAudio,
        bytes: sketch.renderedAudio.size,
        updatedAt: row.updatedAt,
      });
    }
    if (writes.length > 0) await db().blobs.bulkPut(writes);
  } catch (error) {
    const mapped = toStorageError(error);
    if (mapped.code !== 'storage_quota_exceeded') throw mapped;
    audioDropped = true;
    // Record the truth: the row must not claim to have audio it does not have.
    await db().sketches.update(sketch.id, { hasAudio: false }).catch(() => undefined);
  }

  return { audioDropped, sourceDropped };
}

export async function renameSketch(id: string, title: string): Promise<void> {
  const trimmed = title.trim().slice(0, 80);
  try {
    await db().sketches.update(id, { title: trimmed, updatedAt: Date.now() });
  } catch (error) {
    throw toStorageError(error);
  }
}

/** US-0804 - deletes the row and every blob that belonged to it. */
export async function deleteSketch(id: string): Promise<void> {
  try {
    await db().transaction('rw', db().sketches, db().blobs, async () => {
      await db().blobs.where('sketchId').equals(id).delete();
      await db().sketches.delete(id);
    });
  } catch (error) {
    throw toStorageError(error);
  }
}

/** Drops cached audio while keeping the sketch. The user's "free up space" action. */
export async function evictAudio(id: string): Promise<void> {
  try {
    await db().blobs.delete(`${id}:audio`);
    await db().sketches.update(id, { hasAudio: false });
  } catch (error) {
    throw toStorageError(error);
  }
}

export interface StorageStatus {
  usedBytes: number | null;
  quotaBytes: number | null;
  /** 0..1, or null when the browser will not say. */
  usedFraction: number | null;
  /** `true` past 85% - the point at which the next render is likely to fail. */
  low: boolean;
}

export async function storageStatus(): Promise<StorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usedBytes: null, quotaBytes: null, usedFraction: null, low: false };
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const fraction = usage !== undefined && quota !== undefined && quota > 0 ? usage / quota : null;
    return {
      usedBytes: usage ?? null,
      quotaBytes: quota ?? null,
      usedFraction: fraction,
      low: fraction !== null && fraction > 0.85,
    };
  } catch {
    return { usedBytes: null, quotaBytes: null, usedFraction: null, low: false };
  }
}

/**
 * Asks the browser to make storage persistent.
 *
 * Without this, a browser under disk pressure may evict the whole origin
 * without telling anyone - the "no silent deletion" criterion in US-0805 can
 * only be honoured if this is requested. Denial is normal and not an error.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
