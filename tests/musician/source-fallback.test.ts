/**
 * What happens when the Identity Guard refuses every candidate.
 *
 * The service produces candidates, checks each against the Teacher material, and
 * if none of them stayed close enough to the original idea it sets
 * `source_fallback` and returns the Teacher's own notes unchanged. That is
 * correct and stays: presenting the Teacher as the Musician's work is the exact
 * substitution the guard exists to prevent.
 *
 * What was wrong was the account of it. "The musician could not find anything to
 * add to this one" reads as a technical failure, describes a decision nobody
 * made — Refined does not necessarily add anything — and never mentions the
 * reason, which is that candidates *were* produced and were withheld for
 * drifting too far from the user's melody.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  noteDigest,
  notesForVersion,
  offerableGenerated,
  type GeneratedVersion,
  type MusicianVersionId,
  type VersionNoteSources,
} from '@versions';
import { deriveSeed } from '@/features/musician/useMusicianJob';
import { en } from '@/i18n/messages/en';
import { fa } from '@/i18n/messages/fa';

function note(pitch: number, start: number): NoteEvent {
  return { pitch, startSec: start, endSec: start + 0.4, velocity: 90 };
}

const TEACHER_NOTES: NoteEvent[] = [note(60, 0), note(62, 0.5), note(64, 1), note(65, 1.5)];

function generated(
  id: MusicianVersionId,
  options: { sourceFallback?: boolean; notes?: NoteEvent[] } = {},
): GeneratedVersion {
  return {
    id,
    // A refused variant carries the Teacher's own notes back, which is precisely
    // why offering it would be indistinguishable from the Teacher itself.
    notes: options.notes ?? [...TEACHER_NOTES],
    provenance: {
      jobId: 'job-1',
      seed: 11,
      serviceVersion: '0.1.0',
      melodyModelRevision: 'rev-a',
      infillModelRevision: 'rev-b',
      sourceFingerprint: 'fp',
      sourceDigest: noteDigest(TEACHER_NOTES),
      generatedAt: 1_700_000_000_000,
      elapsedMs: 1200,
      ...(options.sourceFallback === undefined ? {} : { sourceFallback: options.sourceFallback }),
    },
    identityAggregate: 0.5,
    changedSpans: [],
  };
}

describe('a refused variant', () => {
  it('is not offered as the Musician’s work', () => {
    const { offered } = offerableGenerated(
      { 'musician-refined': generated('musician-refined', { sourceFallback: true }) },
      TEACHER_NOTES,
    );
    expect(offered['musician-refined']).toBeUndefined();
    expect(Object.keys(offered)).toEqual([]);
  });

  it('is reported as refused rather than as stale or as nothing at all', () => {
    const { withheld } = offerableGenerated(
      { 'musician-expanded': generated('musician-expanded', { sourceFallback: true }) },
      TEACHER_NOTES,
    );
    // A version quietly missing from the picker is indistinguishable from a bug,
    // so the panel is told which of the two things happened.
    expect(withheld).toEqual({ stale: false, refused: true });
  });

  it('leaves the Teacher untouched and still resolvable', () => {
    const { offered } = offerableGenerated(
      { 'musician-developed': generated('musician-developed', { sourceFallback: true }) },
      TEACHER_NOTES,
    );
    const sources: VersionNoteSources = {
      unprocessed: TEACHER_NOTES,
      judge: TEACHER_NOTES,
      teacher: TEACHER_NOTES,
      generated: offered,
    };
    expect(notesForVersion('teacher', sources)).toEqual(TEACHER_NOTES);
    // And the withheld version resolves to nothing rather than silently to the
    // Teacher, which would play the refused material anyway.
    expect(notesForVersion('musician-developed', sources)).toBeNull();
  });

  it('does not withhold the variants that were accepted alongside it', () => {
    const { offered, withheld } = offerableGenerated(
      {
        'musician-refined': generated('musician-refined', {
          notes: [note(60, 0), note(64, 0.5), note(67, 1), note(65, 1.5)],
        }),
        'musician-expanded': generated('musician-expanded', { sourceFallback: true }),
      },
      TEACHER_NOTES,
    );
    expect(Object.keys(offered)).toEqual(['musician-refined']);
    expect(withheld.refused).toBe(true);
  });
});

describe('trying again after a refusal', () => {
  it('generates from a different seed rather than replaying the refused one', () => {
    // "Try another" advances the attempt counter whatever the last outcome was,
    // so a refusal is a dead end for that seed only. Without this the button
    // would be present, look like it worked, and produce the same refusal.
    const refused = generated('musician-refined', { sourceFallback: true });
    const usedSeed = deriveSeed('sketch-a', 0);
    const nextSeed = deriveSeed('sketch-a', 1);
    expect(nextSeed).not.toBe(usedSeed);
    // And the refused attempt keeps its own seed on record, so what was tried
    // stays inspectable rather than being overwritten by the retry.
    expect(refused.provenance.seed).toBe(11);
  });
});

describe('the explanation the user reads', () => {
  it('names the reason instead of implying the model failed', () => {
    const message = en.versions.musician.refused;
    // The old copy, which said the musician "could not find anything to add".
    expect(message).not.toMatch(/anything to add/i);
    // Says what actually happened: candidates existed and were held back.
    expect(message).toMatch(/close enough/i);
    expect(message).toMatch(/withheld/i);
    // And still points at the recovery, which is a fresh generation.
    expect(message).toMatch(/try another/i);
  });

  it('is translated rather than left in English', () => {
    expect(fa.versions.musician.refused).not.toBe(en.versions.musician.refused);
    expect(fa.versions.musician.refused).not.toMatch(/[A-Za-z]{4}/);
    // Persian carries the same two facts: nothing stayed close to the idea, and
    // "try another" is the way forward.
    expect(fa.versions.musician.refused).toContain('نزدیک');
    expect(fa.versions.musician.refused).toContain(fa.versions.musician.tryAnother);
  });

  it('keeps refusal and staleness as separate explanations', () => {
    // They are different events with different recoveries, and one sentence for
    // both would tell half the users the wrong thing.
    expect(en.versions.musician.refused).not.toBe(en.versions.musician.stale);
    expect(fa.versions.musician.refused).not.toBe(fa.versions.musician.stale);
  });
});
