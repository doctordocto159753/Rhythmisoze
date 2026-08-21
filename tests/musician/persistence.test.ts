import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCAL_SCHEMA_VERSION, type NoteEvent, type StoredMusician } from '@contracts';
import { fromStoredMusician, toStoredMusician, deriveSeed } from '@/features/musician/useMusicianJob';
import type { MusicianPair } from '@/features/musician/useMusicianJob';

function note(pitch: number, start: number): NoteEvent {
  return { pitch, startSec: start, endSec: start + 0.4, velocity: 90 };
}

function pair(jobId = 'job-1'): MusicianPair {
  const make = (id: 'musician-refined' | 'musician-developed') => ({
    id,
    notes: [note(60, 0), note(64, 0.5)],
    provenance: {
      jobId,
      seed: 7,
      serviceVersion: '0.1.0',
      melodyModelRevision: 'rev-a',
      infillModelRevision: 'rev-b',
      sourceFingerprint: 'fp',
      generatedAt: 1_700_000_000_000,
      elapsedMs: 900,
    },
    identityAggregate: 0.9,
    changedSpans: [{ startIndex: 1, endIndex: 3, reason: 'interval outlier' }],
  });
  return {
    'musician-refined': make('musician-refined'),
    'musician-developed': make('musician-developed'),
  };
}

describe('persisting Musician output', () => {
  it('stores both versions with everything needed to interpret them later', () => {
    const stored = toStoredMusician({
      result: pair(),
      job: { jobId: 'job-1', phase: 'completed', attempt: 0 },
    });

    expect(stored).toBeDefined();
    expect(Object.keys(stored!.versions).sort()).toEqual([
      'musician-developed',
      'musician-refined',
    ]);
    // Provenance is the reason this is stored rather than derived. A result
    // whose provenance is lost is a result nobody can reason about.
    const refined = stored!.versions['musician-refined']!;
    expect(refined.provenance.seed).toBe(7);
    expect(refined.provenance.melodyModelRevision).toBe('rev-a');
    expect(refined.changedSpans[0]?.reason).toBe('interval outlier');
  });

  it('does not record a finished job', () => {
    // Storing a completed job id would make a reopened workspace poll something
    // that will never change again.
    const stored = toStoredMusician({
      result: pair(),
      job: { jobId: 'job-1', phase: 'completed', attempt: 0 },
    });
    expect(stored!.job).toBeUndefined();
  });

  it('records an in-flight job so it can be resumed', () => {
    const stored = toStoredMusician({
      result: null,
      job: { jobId: 'job-9', phase: 'generating_global', attempt: 2 },
    });
    expect(stored!.job).toMatchObject({ jobId: 'job-9', attempt: 2 });
  });

  it('stores nothing when there is nothing worth storing', () => {
    expect(
      toStoredMusician({ result: null, job: { jobId: null, phase: 'idle', attempt: 0 } }),
    ).toBeUndefined();
    expect(toStoredMusician(null)).toBeUndefined();
  });

  it('round-trips without losing notes', () => {
    const original = pair();
    const stored = toStoredMusician({
      result: original,
      job: { jobId: 'job-1', phase: 'completed', attempt: 0 },
    });
    const restored = fromStoredMusician(stored);

    expect(restored).not.toBeNull();
    expect(restored!['musician-refined'].notes).toEqual(original['musician-refined'].notes);
    expect(restored!['musician-developed'].provenance).toEqual(
      original['musician-developed'].provenance,
    );
  });

  it('restores nothing from a half-written pair', () => {
    // A version whose partner is missing cannot be compared against anything,
    // which is the whole point of there being two.
    const half: StoredMusician = {
      versions: {
        'musician-refined': {
          notes: [note(60, 0)],
          identityAggregate: 0.9,
          changedSpans: [],
          provenance: {
            jobId: 'j',
            seed: 1,
            serviceVersion: '0.1.0',
            melodyModelRevision: 'a',
            infillModelRevision: 'b',
            sourceFingerprint: 'f',
            generatedAt: 0,
            elapsedMs: 0,
          },
        },
      },
    };
    expect(fromStoredMusician(half)).toBeNull();
  });

  it('restores nothing from an absent record', () => {
    // Every sketch made before this feature existed. Must be silent, not an error.
    expect(fromStoredMusician(undefined)).toBeNull();
  });
});

describe('schema migration', () => {
  it('is at version 3', () => {
    expect(LOCAL_SCHEMA_VERSION).toBe(3);
  });

  it('adds only optional fields, so a v2 row is already a valid v3 row', () => {
    // AC-08, checked at the source rather than by mocking IndexedDB. Every
    // field version 3 introduced must be optional; if one ever becomes
    // required, an existing sketch stops being readable and there is no server
    // copy to restore it from.
    const source = readFileSync(
      resolve(__dirname, '../../src/packages/contracts/sketch.ts'),
      'utf8',
    );
    const localSketch = source.slice(
      source.indexOf('export interface LocalSketch'),
      source.indexOf('/** Persisted Musician state.'),
    );
    expect(localSketch).toMatch(/\bmusician\?:/);
    expect(localSketch).toMatch(/\bselectedVersionId\?:/);
  });

  it('declares a Dexie upgrade that only re-stamps the version', () => {
    // A migration that reshapes rows is a migration that can lose them.
    const db = readFileSync(resolve(__dirname, '../../src/features/workspace/db.ts'), 'utf8');
    const upgrade = db.slice(db.indexOf('.upgrade('), db.indexOf('.upgrade(') + 700);
    expect(upgrade).toContain('row.schemaVersion = LOCAL_SCHEMA_VERSION');
    // Nothing else is touched.
    expect(upgrade).not.toMatch(/row\.(rawNotes|rawDrums|retouch|analysis|source)\s*=/);
  });
});

describe('regeneration seeds', () => {
  it('gives a different seed for each attempt', () => {
    // Otherwise "Try another" would sometimes appear to do nothing.
    const seeds = new Set([0, 1, 2, 3, 4].map((attempt) => deriveSeed('sketch-a', attempt)));
    expect(seeds.size).toBe(5);
  });

  it('is deterministic, so a stored provenance means something', () => {
    expect(deriveSeed('sketch-a', 2)).toBe(deriveSeed('sketch-a', 2));
  });

  it('differs between sketches', () => {
    expect(deriveSeed('sketch-a', 0)).not.toBe(deriveSeed('sketch-b', 0));
  });

  it('stays inside the range the service accepts', () => {
    for (const attempt of [0, 1, 50, 999]) {
      const seed = deriveSeed('sketch-a', attempt);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(2_147_483_647);
      expect(Number.isInteger(seed)).toBe(true);
    }
  });
});
