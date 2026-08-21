/**
 * The version registry.
 *
 * Until now the product knew it had exactly three versions, and that knowledge
 * was spread across a union type, a `planVersions` array, three i18n keys and
 * a chain of ternaries picking source notes. Adding two more by extending each
 * of those in turn is how a fourth addition becomes impossible.
 *
 * So this module is the single place that knows what a version *is*. Everything
 * else asks it.
 *
 * ## The two kinds, and why they cannot be one
 *
 * The three original versions are **recipes**: parameters applied to the
 * transcription at render time. They cost nothing to store, they are exact, and
 * they can be recomputed from the raw notes forever.
 *
 * The two Musician versions are **materialised**: actual note events that came
 * back from a model. They cannot be recomputed — the same seed on a different
 * model revision is a different result — so they are stored, with the
 * provenance needed to understand where they came from.
 *
 * Pretending both are the same thing would mean either storing notes we can
 * derive (waste, and a second source of truth that can drift), or claiming we
 * can derive notes we cannot (silent data loss on reload). The registry keeps
 * the distinction and gives everything above it one uniform question to ask:
 * *what notes does this version have?*
 */

import type { NoteEvent } from '@contracts';

export type MusicalVersionId =
  | 'unprocessed'
  | 'judge'
  | 'teacher'
  | 'musician-refined'
  | 'musician-developed'
  | 'musician-expanded';

/** Every version, in the order they are offered. Order is the pipeline order. */
export const VERSION_ORDER: readonly MusicalVersionId[] = [
  'unprocessed',
  'judge',
  'teacher',
  'musician-refined',
  'musician-developed',
  'musician-expanded',
];

/**
 * The generated versions, typed narrowly.
 *
 * Narrower than `MusicalVersionId` on purpose: code that iterates these is
 * indexing a structure that only has the generated ones, and a wider type there
 * turns a correct loop into a type error.
 */
export type MusicianVersionId =
  | 'musician-refined'
  | 'musician-developed'
  | 'musician-expanded';

export const MUSICIAN_VERSION_IDS: readonly MusicianVersionId[] = [
  'musician-refined',
  'musician-developed',
  'musician-expanded',
];

export function isMusicianVersion(id: MusicalVersionId): id is MusicianVersionId {
  // A type predicate rather than a boolean: callers that check this then index
  // a generated-only structure, and without the narrowing they would each need
  // their own cast.
  return (MUSICIAN_VERSION_IDS as readonly MusicalVersionId[]).includes(id);
}

/**
 * How a version's notes come to exist.
 *
 * `derived` — computed locally from the transcription, always available.
 * `generated` — returned by the Musician service, stored, may be absent.
 */
export type VersionOrigin = 'derived' | 'generated';

export interface VersionDescriptor {
  id: MusicalVersionId;
  origin: VersionOrigin;
  /**
   * The version this one is built from. `null` only for `unprocessed`, which is
   * built from the transcription itself.
   *
   * This is not documentation. It is what lets the export manifest record real
   * source relationships, and what makes "the Musician only ever sees Teacher
   * material" a property of the data rather than a promise in a comment.
   */
  sourceVersionId: MusicalVersionId | null;
  /**
   * Whether this version is offered when the Musician is disabled or has not
   * run. The three derived versions always are.
   */
  alwaysAvailable: boolean;
}

const DESCRIPTORS: Readonly<Record<MusicalVersionId, VersionDescriptor>> = {
  unprocessed: {
    id: 'unprocessed',
    origin: 'derived',
    sourceVersionId: null,
    alwaysAvailable: true,
  },
  judge: {
    id: 'judge',
    origin: 'derived',
    sourceVersionId: 'unprocessed',
    alwaysAvailable: true,
  },
  teacher: {
    id: 'teacher',
    origin: 'derived',
    sourceVersionId: 'judge',
    alwaysAvailable: true,
  },
  'musician-refined': {
    id: 'musician-refined',
    origin: 'generated',
    // Teacher, and only Teacher (AC-02). Encoded here so the client can assert
    // it rather than the assertion living in a comment next to the fetch call.
    sourceVersionId: 'teacher',
    alwaysAvailable: false,
  },
  'musician-developed': {
    id: 'musician-developed',
    origin: 'generated',
    sourceVersionId: 'teacher',
    alwaysAvailable: false,
  },
  'musician-expanded': {
    id: 'musician-expanded',
    origin: 'generated',
    // Teacher, like its siblings. Expanded grows the material; it does not get
    // a different source for doing so.
    sourceVersionId: 'teacher',
    alwaysAvailable: false,
  },
};

export function describeVersion(id: MusicalVersionId): VersionDescriptor {
  return DESCRIPTORS[id];
}

/** The versions that exist without the Musician ever having run. */
export function baseVersions(): readonly MusicalVersionId[] {
  return VERSION_ORDER.filter((id) => DESCRIPTORS[id].alwaysAvailable);
}

/**
 * Provenance for a generated version.
 *
 * Everything needed to answer "where did these notes come from?" without the
 * service being reachable. A result whose provenance is lost is a result nobody
 * can reason about later, which is most of why it is stored at all.
 */
export interface MusicianProvenance {
  jobId: string;
  seed: number;
  serviceVersion: string;
  melodyModelRevision: string;
  infillModelRevision: string;
  /** Fingerprint of the Teacher material this was generated from. */
  sourceFingerprint: string;
  generatedAt: number;
  elapsedMs: number;
}

/**
 * A generated version as persisted.
 *
 * `notes` is the payload; everything else is what makes it interpretable a week
 * later. `identity` is deliberately *not* named `score` or `quality` — it is a
 * guardrail reading, and the naming is the first defence against it being shown
 * to a user as a measure of how good the music is.
 */
export interface GeneratedVersion {
  id: MusicalVersionId;
  notes: NoteEvent[];
  provenance: MusicianProvenance;
  identityAggregate: number;
  /** Note-index spans the local-repair model regenerated, with readable reasons. */
  changedSpans: { startIndex: number; endIndex: number; reason: string }[];
}

/**
 * Notes available for each version, as far as this device knows.
 *
 * The derived three are always resolvable, so they are passed in already
 * computed. The generated two are looked up and may be absent — absence is a
 * normal state, not an error.
 */
export interface VersionNoteSources {
  unprocessed: readonly NoteEvent[];
  judge: readonly NoteEvent[];
  teacher: readonly NoteEvent[];
  generated: Partial<Record<MusicalVersionId, GeneratedVersion>>;
}

/**
 * The one question everything above the registry asks.
 *
 * Returns `null` when a generated version has not arrived. Callers must handle
 * that rather than fall back silently to another version's notes: quietly
 * playing the Teacher when the user asked for Refined would make a broken
 * feature look like a working one.
 */
export function notesForVersion(
  id: MusicalVersionId,
  sources: VersionNoteSources,
): readonly NoteEvent[] | null {
  switch (id) {
    case 'unprocessed':
      return sources.unprocessed;
    case 'judge':
      return sources.judge;
    case 'teacher':
      return sources.teacher;
    case 'musician-refined':
    case 'musician-developed':
    case 'musician-expanded':
      return sources.generated[id]?.notes ?? null;
  }
}

/** Which versions can actually be played right now. */
export function availableVersions(
  sources: VersionNoteSources,
  options: { musicianEnabled: boolean },
): readonly MusicalVersionId[] {
  return VERSION_ORDER.filter((id) => {
    if (describeVersion(id).alwaysAvailable) return true;
    if (!options.musicianEnabled) return false;
    return sources.generated[id] !== undefined;
  });
}

/**
 * A stable key for a version's rendered audio.
 *
 * Rendering a WAV is expensive and the result is large, so the review screen
 * caches one render at a time. The key has to change whenever anything that
 * affects the sound changes — the notes, the instrument, the tempo — and must
 * *not* change on unrelated re-renders, or the cache never hits.
 *
 * Generated versions key on their job id and seed rather than their notes: the
 * notes are large, hashing them on every render would cost more than it saves,
 * and a job id plus seed already identifies the result uniquely.
 */
export function renderCacheKey(
  id: MusicalVersionId,
  sources: VersionNoteSources,
  context: { instrumentId: string; bpm: number; retouchAmount: number },
): string {
  const base = `${id}:${context.instrumentId}:${context.bpm.toFixed(3)}:${context.retouchAmount}`;
  const generated = sources.generated[id];
  if (generated) {
    return `${base}:${generated.provenance.jobId}:${generated.provenance.seed}`;
  }
  return base;
}
