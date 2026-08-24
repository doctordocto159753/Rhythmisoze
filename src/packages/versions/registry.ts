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

export function isMusicianVersion(id: string): id is MusicianVersionId {
  // A type predicate rather than a boolean: callers that check this then index
  // a generated-only structure, and without the narrowing they would each need
  // their own cast.
  //
  // Takes `string` rather than `MusicalVersionId` because the interesting call
  // sites are boundaries -- a version id restored from IndexedDB, or the flow's
  // wider `VersionId` union which still carries legacy ids. Narrowing is the job;
  // requiring the caller to have already narrowed defeats it.
  return (MUSICIAN_VERSION_IDS as readonly string[]).includes(id);
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
  /**
   * The service refused: nothing survived the Identity Guard, so these notes are
   * the Teacher's rather than the model's.
   *
   * Recorded in provenance because that is where "where did these notes come
   * from?" is answered, and the answer here is "not from a model". Optional so a
   * version stored before this field existed still reads back.
   */
  sourceFallback?: boolean;
  /**
   * Digest of the Teacher notes this was generated *from*.
   *
   * The service's `input_fingerprint` records the same thing, and cannot be used
   * for the comparison: it is a SHA-256 over a Python-side JSON encoding, so
   * checking a local melody against it would mean reimplementing that encoding in
   * TypeScript and keeping the two byte-identical forever. This is our own digest
   * of our own notes, computed by `noteDigest`, and it only ever has to agree
   * with itself.
   *
   * Optional so a version stored before this field existed still restores. A
   * missing digest is treated as "cannot be checked", not as "matches" — see
   * `isStaleAgainst`.
   */
  sourceDigest?: string;
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

export interface PhraseSpanDigestInput {
  startIndex: number;
  endIndex: number;
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
 * Has the Teacher material moved out from under a generated version?
 *
 * ## The failure this exists to stop
 *
 * The three derived versions are recomputed from the transcription on every
 * render, so they always describe the current take. The Musician's three are
 * stored note data that cannot be recomputed. Nothing connected the two: adjust
 * the cleanup slider, re-run the Judge, reprocess the audio — the Teacher changes,
 * and the stored Refined/Developed/Expanded stay exactly where they were, still
 * offered in the picker, still described as "your idea, shaped".
 *
 * They are now a variation on a phrase that no longer exists, presented as a
 * variation on the one that does. That is the review screen quietly lying about
 * provenance, and it is invisible: the notes are valid, the audio plays, and the
 * only thing wrong is the relationship.
 *
 * ## Why absence is not a match
 *
 * A version stored before `sourceDigest` existed cannot be checked. Treating that
 * as "matches" would make the guard silently vacuous for exactly the data most
 * likely to be stale — the oldest. Treating it as stale is the conservative
 * reading and costs one regeneration.
 */
export function isStaleAgainst(
  generated: GeneratedVersion,
  teacherNotes: readonly NoteEvent[],
  phrases: readonly PhraseSpanDigestInput[] = [],
): boolean {
  const recorded = generated.provenance.sourceDigest;
  if (recorded === undefined) return true;
  return recorded !== noteDigest(teacherNotes, phrases);
}

/**
 * The generated versions that still belong to this Teacher material.
 *
 * Used where the version list and the note resolver are built, so a stale version
 * is not offered and cannot be selected. It is *not* deleted: the stored record
 * survives in the workspace with its own digest, so what happened stays
 * inspectable rather than being quietly erased.
 */
export function freshGenerated(
  generated: Partial<Record<MusicalVersionId, GeneratedVersion>>,
  teacherNotes: readonly NoteEvent[],
  phrases: readonly PhraseSpanDigestInput[] = [],
): Partial<Record<MusicalVersionId, GeneratedVersion>> {
  const fresh: Partial<Record<MusicalVersionId, GeneratedVersion>> = {};
  for (const id of MUSICIAN_VERSION_IDS) {
    const entry = generated[id];
    if (entry && !isStaleAgainst(entry, teacherNotes, phrases)) fresh[id] = entry;
  }
  return fresh;
}

/**
 * Why a generated version is not in the picker.
 *
 * Two different things, kept apart because they mean different things to the
 * person looking at a gap where a version should be.
 */
export interface WithheldReasons {
  /** The Teacher material moved after these were generated. See `isStaleAgainst`. */
  stale: boolean;
  /**
   * The service refused: nothing survived the Identity Guard, so it returned the
   * Teacher's own notes rather than a variation.
   *
   * Not a failure. The model produced candidates and every one of them drifted
   * too far from the user's idea, so none was offered as the Musician's work.
   * Offering the fallback would be the exact substitution the guard exists to
   * prevent — the Teacher presented as the Musician's output — arriving through
   * the front door.
   */
  refused: boolean;
}

/**
 * The generated versions that may actually be offered, and why the others cannot.
 *
 * Two filters for two different lies the picker would otherwise tell, applied in
 * one place so the version list and the note resolver cannot disagree. Offering
 * a version the resolver would refuse, or resolving one the picker withheld, is
 * how a withheld version gets played anyway.
 *
 * Nothing is deleted: the stored record keeps its digest and its flag, so what
 * happened stays inspectable and the panel can say which of the two occurred.
 */
export function offerableGenerated(
  generated: Partial<Record<MusicalVersionId, GeneratedVersion>>,
  teacherNotes: readonly NoteEvent[],
  phrases: readonly PhraseSpanDigestInput[] = [],
): { offered: Partial<Record<MusicalVersionId, GeneratedVersion>>; withheld: WithheldReasons } {
  const fresh = freshGenerated(generated, teacherNotes, phrases);
  const offered: Partial<Record<MusicalVersionId, GeneratedVersion>> = {};
  for (const id of MUSICIAN_VERSION_IDS) {
    const entry = fresh[id];
    if (entry && entry.provenance.sourceFallback !== true) offered[id] = entry;
  }

  const withheld: WithheldReasons = { stale: false, refused: false };
  for (const id of MUSICIAN_VERSION_IDS) {
    const entry = generated[id];
    if (!entry) continue;
    if (entry.provenance.sourceFallback === true) withheld.refused = true;
    else if (isStaleAgainst(entry, teacherNotes, phrases)) withheld.stale = true;
  }
  return { offered, withheld };
}

/**
 * A stable key for a version's rendered audio.
 *
 * Rendering a WAV is expensive and the result is large, so the review screen
 * caches one render at a time. The key has to change whenever anything that
 * affects the sound changes — the notes, the instrument, the tempo — and must
 * *not* change on unrelated re-renders, or the cache never hits.
 *
 * ## Why generated versions key on content, not only on a job id
 *
 * A job id plus seed identifies a result uniquely *provided both are present*.
 * They were not: `toPair` defaulted `jobId` to the empty string at every call
 * site, and the seed is derived from the sketch id and attempt number — so two
 * different generations of the same sketch produced the same key, and the review
 * screen played the previous generation's audio for the new one's notes.
 *
 * So the key also carries `generatedAt`, the model revisions and a cheap digest
 * of the notes themselves. `generatedAt` alone would be enough in practice; the
 * digest is what makes the key correct rather than probably-correct, and it is
 * computed from pitch and timing only, which is all the renderer reads.
 */
export function renderCacheKey(
  id: MusicalVersionId,
  sources: VersionNoteSources,
  context: { instrumentId: string; bpm: number; retouchAmount: number },
): string {
  const base = `${id}:${context.instrumentId}:${context.bpm.toFixed(3)}:${context.retouchAmount}`;
  const generated = sources.generated[id];
  if (generated) {
    const { jobId, seed, generatedAt, melodyModelRevision, infillModelRevision } =
      generated.provenance;
    return [
      base,
      jobId || 'no-job',
      seed,
      generatedAt,
      melodyModelRevision,
      infillModelRevision,
      noteDigest(generated.notes),
    ].join(':');
  }
  return base;
}

/**
 * A short digest of what the renderer will actually read.
 *
 * Not a cryptographic hash and not trying to be: it exists so that two different
 * note sequences cannot share a cache key. FNV-1a over quantised pitch and
 * timing is a few microseconds for a melody of any length this product produces,
 * which is cheap enough to run on every render and far cheaper than the WAV it
 * prevents re-serving.
 */
export function noteDigest(
  notes: readonly NoteEvent[],
  phrases: readonly PhraseSpanDigestInput[] = [],
): string {
  let hash = 2166136261;
  const mix = (value: number): void => {
    hash ^= value | 0;
    hash = Math.imul(hash, 16777619);
  };
  mix(notes.length);
  for (const note of notes) {
    mix(note.pitch);
    // Milliseconds: finer resolution than any renderer distinguishes, and it
    // keeps float noise out of the key.
    mix(Math.round(note.startSec * 1000));
    mix(Math.round(note.endSec * 1000));
    mix(note.velocity);
  }
  // Keep the legacy note-only digest byte-identical when no phrase information
  // exists. Once spans are present they affect the model prompt and therefore
  // participate in provenance too.
  if (phrases.length > 0) {
    mix(phrases.length);
    for (const phrase of phrases) {
      mix(phrase.startIndex);
      mix(phrase.endIndex);
    }
  }
  return (hash >>> 0).toString(36);
}
