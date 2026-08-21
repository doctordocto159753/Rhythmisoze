import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  availableVersions,
  baseVersions,
  describeVersion,
  isMusicianVersion,
  notesForVersion,
  renderCacheKey,
  VERSION_ORDER,
  type GeneratedVersion,
  type VersionNoteSources,
} from '@versions';

function note(pitch: number, start: number): NoteEvent {
  return { pitch, startSec: start, endSec: start + 0.4, velocity: 90 };
}

function generated(
  id: 'musician-refined' | 'musician-developed' | 'musician-expanded',
  jobId = 'job-1',
): GeneratedVersion {
  return {
    id,
    notes: [note(72, 0), note(74, 0.5)],
    provenance: {
      jobId,
      seed: 42,
      serviceVersion: '0.1.0',
      melodyModelRevision: 'rev-a',
      infillModelRevision: 'rev-b',
      sourceFingerprint: 'abc123',
      generatedAt: 1_700_000_000_000,
      elapsedMs: 4200,
    },
    identityAggregate: 0.86,
    changedSpans: [],
  };
}

const sources: VersionNoteSources = {
  unprocessed: [note(60, 0), note(62, 0.5)],
  judge: [note(60, 0), note(62, 0.5), note(64, 1)],
  teacher: [note(60, 0), note(62, 0.5), note(65, 1)],
  generated: {},
};

describe('the version registry', () => {
  it('offers six versions in pipeline order', () => {
    expect(VERSION_ORDER).toEqual([
      'unprocessed',
      'judge',
      'teacher',
      'musician-refined',
      'musician-developed',
      'musician-expanded',
    ]);
  });

  it('keeps the three original versions available without the Musician', () => {
    // AC-01: the product predates this feature and must not depend on it.
    expect(baseVersions()).toEqual(['unprocessed', 'judge', 'teacher']);
  });

  describe('source relationships', () => {
    it('records the pipeline each version came from', () => {
      expect(describeVersion('unprocessed').sourceVersionId).toBeNull();
      expect(describeVersion('judge').sourceVersionId).toBe('unprocessed');
      expect(describeVersion('teacher').sourceVersionId).toBe('judge');
    });

    it('derives every Musician version from Teacher and nothing else', () => {
      // AC-02, as a property of the data rather than a promise in a comment.
      // If either of these ever pointed at `judge` or `unprocessed`, the
      // request builder would send the wrong material and no other test would
      // notice.
      // Expanded grows the material; that does not earn it a different source.
      for (const id of ['musician-refined', 'musician-developed', 'musician-expanded'] as const) {
        expect(describeVersion(id).sourceVersionId).toBe('teacher');
      }
    });

    it('marks only the Musician versions as conditionally available', () => {
      expect(describeVersion('teacher').alwaysAvailable).toBe(true);
      expect(describeVersion('musician-refined').alwaysAvailable).toBe(false);
      expect(isMusicianVersion('musician-developed')).toBe(true);
      expect(isMusicianVersion('judge')).toBe(false);
    });
  });

  describe('resolving notes', () => {
    it('returns the right notes for each derived version', () => {
      expect(notesForVersion('unprocessed', sources)).toHaveLength(2);
      expect(notesForVersion('judge', sources)).toHaveLength(3);
      expect(notesForVersion('teacher', sources)?.[2]?.pitch).toBe(65);
    });

    it('returns null for a Musician version that has not been generated', () => {
      // Not a fallback to another version's notes: quietly playing the Teacher
      // when the user asked for Refined would make a broken feature look like
      // a working one.
      expect(notesForVersion('musician-refined', sources)).toBeNull();
      expect(notesForVersion('musician-developed', sources)).toBeNull();
    });

    it('returns generated notes once they exist', () => {
      const withResult: VersionNoteSources = {
        ...sources,
        generated: { 'musician-refined': generated('musician-refined') },
      };
      expect(notesForVersion('musician-refined', withResult)?.[0]?.pitch).toBe(72);
      // The other half of the pair is still absent, and stays absent.
      expect(notesForVersion('musician-developed', withResult)).toBeNull();
      expect(notesForVersion('musician-expanded', withResult)).toBeNull();
    });
  });

  describe('availability', () => {
    it('offers only the three derived versions when the Musician is off', () => {
      expect(availableVersions(sources, { musicianEnabled: false })).toEqual([
        'unprocessed',
        'judge',
        'teacher',
      ]);
    });

    it('does not offer a Musician version that has no notes', () => {
      // Enabled but never run. Offering it would put a version in the picker
      // that cannot be played.
      expect(availableVersions(sources, { musicianEnabled: true })).toEqual([
        'unprocessed',
        'judge',
        'teacher',
      ]);
    });

    it('offers a Musician version once its notes exist', () => {
      const withAll: VersionNoteSources = {
        ...sources,
        generated: {
          'musician-refined': generated('musician-refined'),
          'musician-developed': generated('musician-developed'),
          'musician-expanded': generated('musician-expanded'),
        },
      };
      expect(availableVersions(withAll, { musicianEnabled: true })).toHaveLength(6);
    });

    it('hides generated versions when the feature is switched off, even if notes exist', () => {
      // A deployment that turns the Musician off after a user generated
      // something must not keep serving it.
      const withBoth: VersionNoteSources = {
        ...sources,
        generated: { 'musician-refined': generated('musician-refined') },
      };
      expect(availableVersions(withBoth, { musicianEnabled: false })).not.toContain(
        'musician-refined',
      );
    });
  });

  describe('render cache keys', () => {
    const context = { instrumentId: 'piano', bpm: 120, retouchAmount: 40 };

    it('separates versions from each other', () => {
      expect(renderCacheKey('judge', sources, context)).not.toBe(
        renderCacheKey('teacher', sources, context),
      );
    });

    it('changes when the instrument or tempo changes', () => {
      expect(renderCacheKey('judge', sources, context)).not.toBe(
        renderCacheKey('judge', sources, { ...context, instrumentId: 'guitar' }),
      );
      expect(renderCacheKey('judge', sources, context)).not.toBe(
        renderCacheKey('judge', sources, { ...context, bpm: 121 }),
      );
    });

    it('is stable across calls with the same inputs', () => {
      // If it were not, the cache would never hit and every re-render would
      // re-render audio.
      expect(renderCacheKey('teacher', sources, context)).toBe(
        renderCacheKey('teacher', sources, context),
      );
    });

    it('changes when a regeneration replaces a generated version', () => {
      // Same version id, different notes. A key that ignored the job id would
      // serve the previous generation's audio for the new one's notes.
      const first: VersionNoteSources = {
        ...sources,
        generated: { 'musician-refined': generated('musician-refined', 'job-1') },
      };
      const second: VersionNoteSources = {
        ...sources,
        generated: { 'musician-refined': generated('musician-refined', 'job-2') },
      };
      expect(renderCacheKey('musician-refined', first, context)).not.toBe(
        renderCacheKey('musician-refined', second, context),
      );
    });
  });
});
