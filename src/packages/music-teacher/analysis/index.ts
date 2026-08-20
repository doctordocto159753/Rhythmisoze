/**
 * What a teacher notices before saying anything.
 *
 * One analysis pass over the Judge's melody, producing the four things every
 * rule needs: what key it is in, where the phrases are, which figures repeat,
 * and what grid the performer was implying.
 *
 * ## Where the pieces come from
 *
 * Key detection is the existing Krumhansl-Schmuckler implementation, which is
 * the port verified against the Python reference by 181 parity assertions.
 * Using a second key detector here would mean two answers to one question, and
 * the tested one would not be the one the Teacher acted on.
 *
 * Scale membership comes from Tonal, which knows the spelling rules that a bare
 * array of semitone offsets does not — B♭ minor and A♯ minor contain the same
 * pitches but a teacher would never write them the same way.
 *
 * The grid comes from `rhythm-extraction`, which recovered it from the
 * performance. The user's tapped BPM is deliberately not consulted: the brief
 * for this layer is explicit that the Teacher must not force it.
 */

import { Note, Scale } from 'tonal';
import type { KeyMode, NoteEvent, PitchClassName } from '@contracts';
import { detectKey } from '@retouch';
import { analyzeMelodyRhythm, type PerformanceRhythm } from '@rhythm-extraction';

export interface KeyAnalysis {
  root: PitchClassName;
  mode: KeyMode;
  confidence: number;
  /** Pitch classes (0-11) belonging to the key. */
  scalePitchClasses: number[];
  /** `true` when the key is solid enough to correct notes against. */
  trusted: boolean;
  /** Duration-weighted share of the melody already inside the scale. */
  conformance: number;
}

export interface Phrase {
  /** Indices into the note array, inclusive. */
  startIndex: number;
  endIndex: number;
  startSec: number;
  endSec: number;
}

export interface Motif {
  /** Interval pattern in semitones, which is what makes a figure recognisable. */
  intervals: number[];
  /** Start indices of each occurrence. */
  occurrences: number[];
}

export interface MelodyAnalysis {
  key: KeyAnalysis | null;
  phrases: Phrase[];
  motifs: Motif[];
  rhythm: PerformanceRhythm | null;
  /** Seconds per grid step implied by the performance. */
  gridStepSec: number | null;
  /** Median note length, used to judge which durations are outliers. */
  medianDurationSec: number;
}

/**
 * Key confidence below which the Teacher will not correct pitches.
 *
 * Higher than the retouch engine's own floor. Retouch snapping a note in a
 * doubtful key is a slider the user can pull back; a teacher confidently
 * "correcting" a note in the wrong key is advice that makes the melody worse,
 * and the user has no way to know it was the key that was wrong.
 */
export const TEACHER_KEY_CONFIDENCE_FLOOR = 0.62;

/**
 * A silence at least this long ends a phrase.
 *
 * Roughly the point where a listener stops hearing two notes as connected. It
 * is scaled by the melody's own note lengths so a slow ballad and a fast line
 * are not judged by the same absolute gap.
 */
const PHRASE_GAP_RATIO = 1.6;
const MIN_PHRASE_GAP_SEC = 0.28;

/** A figure must be this long, and repeat, before it counts as a motif. */
const MIN_MOTIF_INTERVALS = 2;

export function analyseMelody(notes: readonly NoteEvent[], durationSec: number): MelodyAnalysis {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  const medianDurationSec = median(sorted.map((note) => note.endSec - note.startSec));

  const rhythm = sorted.length > 0 ? analyzeMelodyRhythm(sorted, durationSec) : null;

  return {
    key: analyseKey(sorted),
    phrases: findPhrases(sorted, medianDurationSec),
    motifs: findMotifs(sorted),
    rhythm,
    gridStepSec: gridStepFrom(rhythm),
    medianDurationSec,
  };
}

/**
 * Key, and how much of the melody already agrees with it.
 *
 * `conformance` matters as much as `confidence`. A melody that is 95% diatonic
 * with one stray note is a melody with a mistake in it; a melody that is 60%
 * diatonic is probably not in that key at all, and correcting its "wrong" notes
 * would be imposing a key the singer never intended.
 */
export function analyseKey(notes: readonly NoteEvent[]): KeyAnalysis | null {
  if (notes.length < 3) return null;

  const detected = detectKey(notes);
  if (!Number.isFinite(detected.confidence)) return null;

  const scaleName = `${detected.root} ${detected.mode === 'major' ? 'major' : 'minor'}`;
  const scalePitchClasses = Scale.get(scaleName)
    .notes.map((name) => Note.chroma(name))
    .filter((chroma): chroma is number => typeof chroma === 'number');

  // Fall back to nothing rather than to a guess if Tonal did not recognise it.
  if (scalePitchClasses.length === 0) return null;

  let inside = 0;
  let total = 0;
  for (const note of notes) {
    const weight = Math.max(0.05, note.endSec - note.startSec);
    total += weight;
    if (scalePitchClasses.includes(((note.pitch % 12) + 12) % 12)) inside += weight;
  }
  const conformance = total > 0 ? inside / total : 0;

  return {
    root: detected.root,
    mode: detected.mode,
    confidence: detected.confidence,
    scalePitchClasses,
    conformance,
    // Both tests must pass: a confident key that the melody mostly ignores is
    // not a key worth correcting toward.
    trusted: detected.confidence >= TEACHER_KEY_CONFIDENCE_FLOOR && conformance >= 0.6,
  };
}

/** Phrases, split at silences long relative to the melody's own note lengths. */
export function findPhrases(notes: readonly NoteEvent[], medianDurationSec: number): Phrase[] {
  if (notes.length === 0) return [];

  const gapThreshold = Math.max(MIN_PHRASE_GAP_SEC, medianDurationSec * PHRASE_GAP_RATIO);
  const phrases: Phrase[] = [];
  let startIndex = 0;

  for (let i = 1; i <= notes.length; i += 1) {
    const previous = notes[i - 1] as NoteEvent;
    const current = notes[i];
    const ends = current === undefined || current.startSec - previous.endSec >= gapThreshold;
    if (!ends) continue;

    phrases.push({
      startIndex,
      endIndex: i - 1,
      startSec: (notes[startIndex] as NoteEvent).startSec,
      endSec: previous.endSec,
    });
    startIndex = i;
  }

  return phrases;
}

/**
 * Repeated interval figures.
 *
 * Compared by *interval* rather than by absolute pitch, because that is what
 * makes a figure recognisable: the same shape starting three semitones higher
 * is still the same idea, and a teacher would want both occurrences to agree.
 */
export function findMotifs(notes: readonly NoteEvent[]): Motif[] {
  if (notes.length < MIN_MOTIF_INTERVALS + 2) return [];

  const intervals: number[] = [];
  for (let i = 1; i < notes.length; i += 1) {
    intervals.push((notes[i] as NoteEvent).pitch - (notes[i - 1] as NoteEvent).pitch);
  }

  const found = new Map<string, number[]>();
  // Longest patterns first: a four-note figure is a better description than the
  // three-note figure hiding inside it.
  for (let length = Math.min(4, intervals.length); length >= MIN_MOTIF_INTERVALS; length -= 1) {
    for (let start = 0; start + length <= intervals.length; start += 1) {
      const pattern = intervals.slice(start, start + length);
      // A run of repeated notes is not a motif, it is a held note stuttering.
      if (pattern.every((value) => value === 0)) continue;
      const key = pattern.join(',');
      const list = found.get(key) ?? [];
      // Overlapping occurrences describe the same material twice.
      if (list.length > 0 && start - (list[list.length - 1] as number) < length) continue;
      list.push(start);
      found.set(key, list);
    }
  }

  return [...found.entries()]
    .filter(([, occurrences]) => occurrences.length >= 2)
    .map(([key, occurrences]) => ({
      intervals: key.split(',').map(Number),
      occurrences,
    }))
    .sort((a, b) => b.intervals.length - a.intervals.length || b.occurrences.length - a.occurrences.length);
}

/**
 * The grid the performance implied.
 *
 * Sixteenths of the detected beat. Returns `null` when no pulse was confidently
 * heard, which is the case where the Teacher must leave timing alone rather
 * than invent a grid to correct toward.
 */
function gridStepFrom(rhythm: PerformanceRhythm | null): number | null {
  if (rhythm === null || !rhythm.reliable) return null;
  const beatSec = 60 / rhythm.tempo.bpm;
  return beatSec / 4;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
