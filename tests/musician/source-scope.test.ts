/**
 * Musician results belong to the source they were generated from.
 *
 * The hook is deliberately reluctant to clear `result`: a failed regeneration,
 * a rejected one or a cancelled run must never destroy something the user
 * accepted. That reluctance is right within one source and wrong across two —
 * a variation on a recording the user has replaced is a variation on nothing,
 * and offering it under the new source's name is the Teacher's material
 * presented as the Musician's work.
 *
 * Two independent defences, tested here and in `registry.test.ts`:
 *
 *  - the state is *scoped*, so a new source empties it in the same commit;
 *  - `offerableGenerated` re-checks the digest, so anything restored from the
 *    workspace against different Teacher material is withheld anyway.
 *
 * The first is the one that was missing. The second is not a substitute for it:
 * a digest check notices afterwards, and "afterwards" is a render in which the
 * picker has already offered the wrong thing.
 */

import { describe, expect, it } from 'vitest';
import { AppError, type NoteEvent } from '@contracts';
import {
  deriveSeed,
  scopeToSource,
  type MusicianJobState,
  type MusicianPair,
} from '@/features/musician/useMusicianJob';
import { noteDigest, offerableGenerated, type GeneratedVersion } from '@versions';

function note(pitch: number, start: number): NoteEvent {
  return { pitch, startSec: start, endSec: start + 0.4, velocity: 90 };
}

const SOURCE_A_TEACHER: NoteEvent[] = [note(60, 0), note(62, 0.5), note(64, 1)];
const SOURCE_B_TEACHER: NoteEvent[] = [note(43, 0), note(55, 0.3), note(74, 0.6)];

function generatedFor(
  id: 'musician-refined' | 'musician-developed' | 'musician-expanded',
  teacher: readonly NoteEvent[],
): GeneratedVersion {
  return {
    id,
    notes: [note(72, 0), note(74, 0.5)],
    provenance: {
      jobId: 'job-a',
      seed: 11,
      serviceVersion: '0.1.0',
      melodyModelRevision: 'rev-a',
      infillModelRevision: 'rev-b',
      sourceFingerprint: 'fp',
      sourceDigest: noteDigest(teacher),
      generatedAt: 1_700_000_000_000,
      elapsedMs: 900,
    },
    identityAggregate: 0.93,
    changedSpans: [],
  };
}

function pairFor(teacher: readonly NoteEvent[]): MusicianPair {
  return {
    'musician-refined': generatedFor('musician-refined', teacher),
    'musician-developed': generatedFor('musician-developed', teacher),
    'musician-expanded': generatedFor('musician-expanded', teacher),
  };
}

const ACCEPTED_FOR_A: MusicianJobState = {
  phase: 'completed',
  jobId: 'job-a',
  result: pairFor(SOURCE_A_TEACHER),
  pending: null,
  error: null,
  attempt: 3,
};

describe('a new source', () => {
  it('takes the accepted result with it', () => {
    const scoped = scopeToSource(ACCEPTED_FOR_A, 'sketch#1', 'sketch#2');
    expect(scoped.result).toBeNull();
    expect(scoped.phase).toBe('idle');
    expect(scoped.jobId).toBeNull();
  });

  it('takes a pending regeneration the user had not decided on', () => {
    const undecided: MusicianJobState = { ...ACCEPTED_FOR_A, pending: pairFor(SOURCE_A_TEACHER) };
    expect(scopeToSource(undecided, 'sketch#1', 'sketch#2').pending).toBeNull();
  });

  it('abandons a run that was still going', () => {
    const running: MusicianJobState = { ...ACCEPTED_FOR_A, phase: 'generating_global' };
    expect(scopeToSource(running, 'sketch#1', 'sketch#2').phase).toBe('idle');
  });

  it('does not carry a failure across either', () => {
    const failed: MusicianJobState = {
      ...ACCEPTED_FOR_A,
      phase: 'failed',
      error: new AppError('musician_failed', 'retry', 'service returned 500'),
    };
    expect(scopeToSource(failed, 'sketch#1', 'sketch#2').error).toBeNull();
  });

  it('starts the attempt count again, so the first seed is genuinely the first', () => {
    const scoped = scopeToSource(ACCEPTED_FOR_A, 'sketch#1', 'sketch#2');
    expect(scoped.attempt).toBe(0);
    // A count carried over would have started this source at a seed nothing in
    // its own provenance could explain.
    expect(deriveSeed('sketch#2', scoped.attempt)).not.toBe(
      deriveSeed('sketch#2', ACCEPTED_FOR_A.attempt),
    );
  });
});

describe('the same source', () => {
  it('keeps everything, which is the whole point of the reluctance', () => {
    // Reprocessing a take, adjusting cleanup, re-running the Judge — the source
    // has not changed, so a result the user accepted stays accepted.
    expect(scopeToSource(ACCEPTED_FOR_A, 'sketch#1', 'sketch#1')).toBe(ACCEPTED_FOR_A);
  });

  it('keeps an undecided regeneration too', () => {
    const undecided: MusicianJobState = { ...ACCEPTED_FOR_A, pending: pairFor(SOURCE_A_TEACHER) };
    expect(scopeToSource(undecided, 'sketch#1', 'sketch#1').pending).not.toBeNull();
  });
});

describe('the second line of defence', () => {
  it('withholds a restored result whose Teacher material is not the current one', () => {
    // If a result ever reaches the picker despite the scoping — restored from
    // the workspace, say — the digest still refuses it.
    const { offered, withheld } = offerableGenerated(pairFor(SOURCE_A_TEACHER), SOURCE_B_TEACHER);
    expect(Object.keys(offered)).toEqual([]);
    expect(withheld.stale).toBe(true);
  });

  it('offers a result that does belong to the current material', () => {
    const { offered } = offerableGenerated(pairFor(SOURCE_B_TEACHER), SOURCE_B_TEACHER);
    expect(Object.keys(offered)).toHaveLength(3);
  });
});
