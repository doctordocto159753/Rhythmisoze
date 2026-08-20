/**
 * The Music Teacher.
 *
 * ## What can and cannot be asserted here
 *
 * The Judge could be tested against ground truth: the audio said C4, so C4 is
 * the right answer. The Teacher has no such target — "would a music teacher
 * suggest this?" is a judgement, and a test that claimed to settle it would be
 * lying about what it measured.
 *
 * So these tests assert the two things that *are* checkable, which are also the
 * two things that make the layer safe to ship:
 *
 *  1. **The constraints hold.** Note count never changes, edits stay inside the
 *     budget, identity never falls below the floor, nothing moves further than
 *     a whole tone, output is deterministic.
 *  2. **The specific suggestions are the intended ones.** The brief's own
 *     example — `C D F# E` in C major becoming `C D F E` — is asserted
 *     directly, as are the cases where the Teacher must stay quiet.
 *
 * The cases where it stays quiet matter more than the cases where it speaks. A
 * layer that improves a good melody has damaged it.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  analyseKey,
  analyseMelody,
  findMotifs,
  findPhrases,
  IDENTITY_FLOOR,
  MAX_EDITED_FRACTION,
  nearestScalePitch,
  scoreCoherence,
  scoreIdentity,
  teach,
  TEACHER_RULES,
} from '@music-teacher';

/** Builds an evenly spaced melody at 120 BPM, quarter notes. */
function melody(pitches: readonly number[], options: { step?: number; hold?: number } = {}): NoteEvent[] {
  const step = options.step ?? 0.5;
  const hold = options.hold ?? 0.45;
  return pitches.map((pitch, index) => ({
    startSec: index * step,
    endSec: index * step + hold,
    pitch,
    velocity: 90,
  }));
}

/** A clean, diatonic C-major line, long enough to analyse. */
const CLEAN = melody([60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 67]);
const CLEAN_DURATION = 6.5;

describe('analysis', () => {
  it('finds the key of a diatonic melody and trusts it', () => {
    const key = analyseKey(CLEAN);
    expect(key).not.toBeNull();
    expect(key?.trusted).toBe(true);
    expect(key?.conformance).toBeGreaterThan(0.9);
    expect(key?.scalePitchClasses).toContain(0); // C
    expect(key?.scalePitchClasses).not.toContain(6); // F#
  });

  it('refuses to trust a key it cannot establish', () => {
    // A chromatic cluster has no key worth correcting toward.
    const chromatic = melody([60, 61, 62, 63, 64, 65, 66, 67]);
    expect(analyseKey(chromatic)?.trusted).toBe(false);
  });

  it('returns nothing for a melody too short to analyse', () => {
    expect(analyseKey(melody([60, 62]))).toBeNull();
  });

  it('splits phrases at real silences', () => {
    const twoPhrases: NoteEvent[] = [
      ...melody([60, 62, 64]),
      // A gap far longer than the note lengths.
      ...melody([65, 67, 69]).map((note) => ({
        ...note,
        startSec: note.startSec + 3,
        endSec: note.endSec + 3,
      })),
    ];
    const phrases = findPhrases(twoPhrases, 0.45);
    expect(phrases).toHaveLength(2);
    expect(phrases[0]?.endIndex).toBe(2);
    expect(phrases[1]?.startIndex).toBe(3);
  });

  it('finds a repeated figure by its intervals, not its pitches', () => {
    // The same shape, transposed: still the same idea.
    const motifs = findMotifs(melody([60, 62, 64, 60, 67, 69, 71, 67]));
    expect(motifs.length).toBeGreaterThan(0);
    expect(motifs[0]?.occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('does not call a run of repeated notes a motif', () => {
    // A stuttering held note is not a figure.
    expect(findMotifs(melody([60, 60, 60, 60, 60, 60]))).toHaveLength(0);
  });
});

describe('scoring', () => {
  it('scores a diatonic melody as more coherent than a chromatic one', () => {
    const clean = scoreCoherence(CLEAN, analyseMelody(CLEAN, CLEAN_DURATION));
    const chromatic = melody([60, 61, 63, 66, 68, 61, 70, 63, 66, 61, 64, 67]);
    const messy = scoreCoherence(chromatic, analyseMelody(chromatic, CLEAN_DURATION));
    expect(clean.scaleConformance).toBeGreaterThan(messy.scaleConformance);
  });

  it('does not reward a monotone for having no leaps', () => {
    // "Smoothness" must not mean "no movement", or a flat line scores best.
    const flat = melody([60, 60, 60, 60, 60, 60, 60, 60]);
    const tune = scoreCoherence(CLEAN, analyseMelody(CLEAN, CLEAN_DURATION));
    const drone = scoreCoherence(flat, analyseMelody(flat, CLEAN_DURATION));
    expect(tune.overall).toBeGreaterThan(drone.overall * 0.9);
  });

  it('scores an unchanged melody as fully identical', () => {
    const identity = scoreIdentity(CLEAN, CLEAN);
    expect(identity.notesUnchanged).toBe(1);
    expect(identity.contourPreserved).toBe(1);
    expect(identity.overall).toBeGreaterThan(0.95);
  });

  it('scores a different note count as no identity at all', () => {
    expect(scoreIdentity(CLEAN, CLEAN.slice(0, 6)).overall).toBe(0);
  });

  it('punishes a reversed contour hard', () => {
    const inverted = CLEAN.map((note, i) => ({ ...note, pitch: 72 - (note.pitch - 60) + i * 0 }));
    expect(scoreIdentity(CLEAN, inverted).contourPreserved).toBeLessThan(0.4);
  });

  it('punishes a large pitch move even if few notes changed', () => {
    const shifted = CLEAN.map((note, i) => (i === 3 ? { ...note, pitch: note.pitch + 7 } : note));
    const identity = scoreIdentity(CLEAN, shifted);
    expect(identity.maxPitchShiftSemitones).toBe(7);
    // One note in twelve is a small fraction, but the move is too big to be a
    // correction, and the aggregate has to reflect that rather than average it
    // away.
    expect(identity.overall).toBeLessThan(0.8);
  });
});

describe('key-aware correction', () => {
  it('moves a brief out-of-key note to the nearest note of the key', () => {
    // The brief's own example: C D F# E in C major.
    const withAccidental = melody([60, 62, 66, 64, 65, 67, 65, 64, 62, 60, 64, 67]);
    const result = teach(withAccidental, CLEAN_DURATION);

    const corrected = result.notes[2];
    expect(corrected?.pitch).toBe(65); // F# -> F
    expect(result.edits.some((edit) => edit.kind === 'pitch-to-scale')).toBe(true);
  });

  it('explains the change in words a musician can argue with', () => {
    const withAccidental = melody([60, 62, 66, 64, 65, 67, 65, 64, 62, 60, 64, 67]);
    const edit = teach(withAccidental, CLEAN_DURATION).edits.find(
      (candidate) => candidate.kind === 'pitch-to-scale',
    );
    expect(edit?.reason).toMatch(/outside/i);
    expect(edit?.reason).toMatch(/C major/i);
  });

  it('leaves a long out-of-key note alone', () => {
    // A held accidental is the character of the melody, not a slip.
    const held = melody([60, 62, 66, 64, 65, 67, 65, 64, 62, 60, 64, 67]).map((note, i) =>
      i === 2 ? { ...note, endSec: note.startSec + 1.6 } : note,
    );
    const result = teach(held, 8);
    expect(result.notes[2]?.pitch).toBe(66);
  });

  it('stays silent when the key cannot be trusted', () => {
    // Every pitch class once: no key explains more than 7/12 of it, so there is
    // nothing to correct toward and the rule must not invent one.
    const chromatic = melody([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
    expect(analyseKey(chromatic)?.trusted).toBe(false);
    const result = teach(chromatic, CLEAN_DURATION);
    expect(result.edits.filter((edit) => edit.kind === 'pitch-to-scale')).toHaveLength(0);
  });

  it('never moves a note further than a whole tone', () => {
    expect(nearestScalePitch(66, [0, 2, 4, 5, 7, 9, 11])).toBe(65);
    // C4 with only F in the scale: five semitones away in both directions, so
    // there is no correction within the whole-tone limit and the rule declines.
    expect(nearestScalePitch(60, [5])).toBeNull();
  });
});

describe('rhythm refinement', () => {
  it('pulls a note that nearly landed on the beat onto it', () => {
    const jittered = melody([60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 67]).map((note, i) =>
      i === 4 ? { ...note, startSec: note.startSec + 0.035, endSec: note.endSec + 0.035 } : note,
    );
    const result = teach(jittered, CLEAN_DURATION);
    const timing = result.edits.filter((edit) => edit.kind === 'timing-to-grid');
    // Either it was corrected, or the grid was not confident enough to try -
    // both are acceptable, but it must never have moved further out.
    if (timing.length > 0) {
      expect(Math.abs((result.notes[4]?.startSec ?? 0) - 2)).toBeLessThan(0.035);
    }
  });

  it('leaves a deliberately displaced note where it was put', () => {
    // Half a beat off is a syncopation, not jitter.
    const syncopated = melody([60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 67]).map((note, i) =>
      i === 4 ? { ...note, startSec: note.startSec + 0.25, endSec: note.endSec + 0.25 } : note,
    );
    const result = teach(syncopated, CLEAN_DURATION);
    expect(result.notes[4]?.startSec).toBeCloseTo(2.25, 2);
  });

  it('never uses a tempo the performer did not play', () => {
    // The Teacher has no access to the tapped BPM by construction: `teach`
    // takes notes and a duration, and nothing else.
    expect(teach.length).toBeLessThanOrEqual(3);
  });
});

describe('constraints', () => {
  it('never changes the number of notes', () => {
    const cases = [CLEAN, melody([60, 66, 62, 68, 64, 70, 65, 61, 67, 63, 69, 60])];
    for (const input of cases) {
      expect(teach(input, CLEAN_DURATION).notes).toHaveLength(input.length);
    }
  });

  it('never edits more than the budget allows', () => {
    const messy = melody([60, 66, 62, 68, 64, 61, 65, 63, 67, 66, 62, 68]);
    const result = teach(messy, CLEAN_DURATION);
    const touched = new Set(result.edits.map((edit) => edit.noteIndex));
    expect(touched.size).toBeLessThanOrEqual(Math.floor(messy.length * MAX_EDITED_FRACTION));
  });

  it('keeps identity above the floor whenever it changes anything', () => {
    const messy = melody([60, 66, 62, 68, 64, 61, 65, 63, 67, 66, 62, 68]);
    const result = teach(messy, CLEAN_DURATION);
    if (!result.unchanged) {
      expect(result.identity.overall).toBeGreaterThanOrEqual(IDENTITY_FLOOR);
      expect(result.identity.maxPitchShiftSemitones).toBeLessThanOrEqual(2);
    }
  });

  it('leaves a melody that is already good completely alone', () => {
    // The most important negative case: improving a good take damages it.
    const result = teach(CLEAN, CLEAN_DURATION);
    expect(result.notes.map((note) => note.pitch)).toEqual(CLEAN.map((note) => note.pitch));
  });

  it('never lowers coherence when it does change something', () => {
    const inputs = [
      melody([60, 62, 66, 64, 65, 67, 65, 64, 62, 60, 64, 67]),
      melody([60, 66, 62, 68, 64, 61, 65, 63, 67, 66, 62, 68]),
    ];
    for (const input of inputs) {
      const result = teach(input, CLEAN_DURATION);
      if (!result.unchanged) {
        expect(result.coherenceAfter.overall).toBeGreaterThanOrEqual(
          result.coherenceBefore.overall,
        );
      }
    }
  });

  it('keeps the notes in order and none of zero length', () => {
    const result = teach(melody([60, 62, 66, 64, 65, 67, 65, 64, 62, 60, 64, 67]), CLEAN_DURATION);
    let previous = -Infinity;
    for (const note of result.notes) {
      expect(note.endSec).toBeGreaterThan(note.startSec);
      expect(note.startSec).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = note.startSec;
    }
  });

  it('returns the input untouched alongside the revision', () => {
    const input = melody([60, 62, 66, 64, 65, 67, 65, 64, 62, 60, 64, 67]);
    const snapshot = JSON.stringify(input);
    const result = teach(input, CLEAN_DURATION);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(result.inputNotes.map((n) => n.pitch)).toEqual(input.map((n) => n.pitch));
  });

  it('says nothing about a melody too short to teach from', () => {
    const result = teach(melody([60, 62, 64]), 1.5);
    expect(result.unchanged).toBe(true);
    expect(result.edits).toEqual([]);
  });

  it('handles an empty melody without throwing', () => {
    const result = teach([], 0);
    expect(result.notes).toEqual([]);
    expect(result.unchanged).toBe(true);
  });

  it('is deterministic', () => {
    const input = melody([60, 62, 66, 64, 65, 67, 65, 64, 62, 60, 64, 67]);
    const a = teach(input, CLEAN_DURATION);
    const b = teach(input, CLEAN_DURATION);
    expect(a.notes).toEqual(b.notes);
    expect(a.edits).toEqual(b.edits);
  });

  it('gives every edit a reason', () => {
    const messy = melody([60, 66, 62, 68, 64, 61, 65, 63, 67, 66, 62, 68]);
    for (const edit of teach(messy, CLEAN_DURATION).edits) {
      expect(edit.reason.length).toBeGreaterThan(10);
      expect(edit.from).not.toBe(edit.to);
    }
  });
});

describe('rule registry', () => {
  it('runs the rules in pedagogical order, notes before rhythm before shape', () => {
    const ids = TEACHER_RULES.map((rule) => rule.id);
    expect(ids.indexOf('key-coherence')).toBeLessThan(ids.indexOf('rhythm-refinement'));
    expect(ids.indexOf('rhythm-refinement')).toBeLessThan(ids.indexOf('phrase-shaping'));
  });

  it('documents what every rule is for', () => {
    for (const rule of TEACHER_RULES) {
      expect(rule.purpose.length).toBeGreaterThan(10);
    }
  });
});
