/**
 * Register arbitration, pinned to the two corpus cases that pull opposite ways.
 *
 * Both fixtures are the *measured* output of the real engines on the real
 * synthetic corpus, copied here as literals. That is deliberate: these are the
 * numbers the rule was designed against, and pinning them means a change to the
 * thresholds has to face the evidence that set them rather than a fixture
 * invented to agree with the new value.
 *
 *  - `diff-octave-leap` — the contour engine is wrong and must be corrected.
 *  - `diff-harmonic-heavy` — the contour engine is right and must be left
 *    alone, even though the witness reports something exactly an octave above
 *    it and never reports the fundamental at all.
 *
 * A rule that only satisfies the first is easy and breaks the product.
 *
 * The third fixture is `real-test22`, from the pinned recordings, and it is the
 * one that forced corroboration into the design: a span where the two witnesses
 * disagree with the candidate *and* with each other. Nothing may move there,
 * and nothing may move on one witness anywhere.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  arbitrateRegister,
  DEFAULT_REGISTER_OPTIONS,
  ENGINE_STRENGTHS,
  notableDecisions,
  type EvidenceSource,
} from '@evidence';

const note = (pitch: number, startSec: number, endSec: number): NoteEvent => ({
  startSec,
  endSec,
  pitch,
  velocity: 90,
});

function witness(
  notes: ReadonlyArray<[number, number, number]>,
  engineId: EvidenceSource['engineId'] = 'basic-pitch',
): EvidenceSource {
  return {
    engineId,
    view: 'original',
    notes: notes.map(([pitch, startSec, endSec]) => ({ pitch, startSec, endSec })),
  };
}

/**
 * `diff-octave-leap`: truth is C4 → C5 → C4.
 *
 * The contour engine reads the middle note an octave low — YIN on the
 * subharmonic — and Basic Pitch reads it correctly across almost the whole
 * span.
 */
const LEAP_CANDIDATE: NoteEvent[] = [
  note(60, 0.18, 0.79),
  note(60, 0.88, 1.49),
  note(60, 1.58, 2.19),
];
const LEAP_WITNESS = witness([
  [60, 0.20, 0.73],
  [60, 0.73, 0.84],
  [72, 0.91, 1.52],
  [60, 1.60, 2.13],
  [60, 2.13, 2.24],
]);
/** GAME's reading of the same phrase, from its own inference run. */
const LEAP_CORROBORATION = witness(
  [
    [60, 0.22, 0.92],
    [72, 0.92, 1.62],
    [60, 1.62, 2.21],
  ],
  'game',
);

/**
 * `diff-harmonic-heavy`: truth is A3 → C4 → E4, and the contour engine has all
 * three right.
 *
 * Basic Pitch reports the harmonic above each note as if it were a note, and
 * over the middle note it never reports the fundamental at all — only 79 and 72.
 * 72 is exactly an octave above the contour engine's 60.
 */
const HARMONIC_CANDIDATE: NoteEvent[] = [
  note(57, 0.18, 0.79),
  note(60, 0.88, 1.49),
  note(64, 1.58, 2.19),
];
const HARMONIC_WITNESS = witness([
  [57, 0.20, 0.84],
  [69, 0.21, 0.27],
  [79, 0.88, 1.09],
  [72, 0.91, 1.07],
  [64, 1.60, 2.23],
  [76, 1.61, 2.18],
]);

describe('the octave leap the contour engine cannot hear', () => {
  const result = arbitrateRegister(LEAP_CANDIDATE, [LEAP_WITNESS, LEAP_CORROBORATION]);

  it('corrects the middle note and only the middle note', () => {
    expect(result.notes.map((n) => n.pitch)).toEqual([60, 72, 60]);
    expect(result.corrected).toBe(1);
  });

  it('records why, and which engines agreed', () => {
    const decision = result.decisions[1];
    expect(decision?.outcome).toBe('corrected');
    expect(decision?.fromPitch).toBe(60);
    expect(decision?.toPitch).toBe(72);
    expect(decision?.agreeingEngines.sort()).toEqual(['basic-pitch', 'game']);
    // The witnesses covered essentially the whole note, which is the
    // measurement the rule turns on.
    expect(decision?.coverage).toBeGreaterThan(0.9);
  });

  it('will not make the same correction on one witness alone', () => {
    // The default deployment. The observation is identical and is recorded as
    // such; what it lacks is a second engine, and that is the whole difference
    // between this and the span in `real-test22` below.
    const solo = arbitrateRegister(LEAP_CANDIDATE, [LEAP_WITNESS]);
    expect(solo.notes.map((n) => n.pitch)).toEqual([60, 60, 60]);
    expect(solo.corrected).toBe(0);
    expect(solo.unresolved).toBe(1);
    expect(solo.decisions[1]?.outcome).toBe('declined_uncorroborated');
  });

  it('leaves the notes the witness agreed with untouched', () => {
    expect(result.decisions[0]?.outcome).toBe('agreed');
    expect(result.decisions[2]?.outcome).toBe('agreed');
  });

  it('moves nothing but the pitch', () => {
    result.notes.forEach((after, index) => {
      const before = LEAP_CANDIDATE[index] as NoteEvent;
      expect(after.startSec).toBe(before.startSec);
      expect(after.endSec).toBe(before.endSec);
      expect(after.velocity).toBe(before.velocity);
    });
  });
});

describe('the harmonics that look exactly like an octave error', () => {
  const result = arbitrateRegister(HARMONIC_CANDIDATE, [HARMONIC_WITNESS]);

  it('is declined on the evidence, not merely for want of a second engine', () => {
    // Worth separating. If this case only survived because corroboration was
    // missing, the coverage and dominance gates would be untested and the case
    // would break the day the optional service was deployed.
    const corroborated = arbitrateRegister(HARMONIC_CANDIDATE, [
      HARMONIC_WITNESS,
      witness([[79, 0.88, 1.09], [72, 0.91, 1.07]], 'game'),
    ]);
    expect(corroborated.notes.map((n) => n.pitch)).toEqual([57, 60, 64]);
    expect(corroborated.corrected).toBe(0);
  });

  it('changes nothing', () => {
    // The case that a naive "+12 wins" rule breaks. All three notes are already
    // correct, and the middle one has no fundamental in the witness at all.
    expect(result.notes.map((n) => n.pitch)).toEqual([57, 60, 64]);
    expect(result.corrected).toBe(0);
  });

  it('declines the middle note on the grounds that actually apply', () => {
    const decision = result.decisions[1];
    // The loudest thing the witness reports over that span is 79 — a different
    // pitch class — so the reading is disqualified before the octave candidate
    // is even reached.
    expect(decision?.outcome).toBe('declined_contested');
    expect(decision?.reason).toMatch(/not an octave apart/);
  });

  it('treats the outer notes as agreement despite the harmonics above them', () => {
    expect(result.decisions[0]?.outcome).toBe('agreed');
    expect(result.decisions[2]?.outcome).toBe('agreed');
  });

  it('keeps the disagreement visible rather than discarding it', () => {
    // Nothing moved, but something was noticed. Silently discarding that is how
    // a take comes out wrong with no way to find out why.
    expect(result.unresolved).toBe(1);
    expect(notableDecisions(result)).toHaveLength(1);
  });
});

/**
 * `real-test22`, at 1.56 s and 2.30 s.
 *
 * The contour engine reads 57 both times. Basic Pitch reads 45 both times, with
 * full coverage and no competition — everything the coverage and dominance
 * gates ask for. GAME reads 53 and 64. Two witnesses, three answers, and no
 * reason to prefer any of them.
 */
describe('a span where the witnesses disagree with each other', () => {
  const candidate: NoteEvent[] = [note(57, 1.56, 1.95), note(57, 2.30, 2.68)];
  const result = arbitrateRegister(candidate, [
    witness([[45, 1.50, 2.00], [45, 2.25, 2.70]]),
    witness([[53, 1.27, 1.67], [64, 2.08, 2.56]], 'game'),
  ]);

  it('moves nothing', () => {
    expect(result.notes.map((n) => n.pitch)).toEqual([57, 57]);
    expect(result.corrected).toBe(0);
  });

  it('records the disagreement rather than resolving it', () => {
    expect(result.unresolved).toBe(2);
    for (const decision of result.decisions) {
      expect(decision.outcome).not.toBe('corrected');
    }
  });
});

describe('the limits of what a register witness may do', () => {
  it('requires corroboration by default, and no engine can act alone', () => {
    // The threshold is set above every engine in the roster on purpose: the
    // best of them has no measured register accuracy on real takes, because no
    // ground truth exists for them. This asserts the door is shut rather than
    // merely narrow.
    expect(DEFAULT_REGISTER_OPTIONS.minWitnesses).toBe(2);
    for (const strengths of Object.values(ENGINE_STRENGTHS)) {
      expect(strengths.register).toBeLessThan(DEFAULT_REGISTER_OPTIONS.soloRegisterStrength);
    }
  });

  it('will not move a note by two octaves', () => {
    // Not what a subharmonic error looks like. A gap this large means something
    // else went wrong, and moving the note would hide it.
    const result = arbitrateRegister(
      [note(60, 0, 1)],
      [witness([[84, 0, 1]]), witness([[84, 0, 1]], 'game')],
    );
    expect(result.notes[0]?.pitch).toBe(60);
    expect(result.decisions[0]?.outcome).toBe('declined_contested');
  });

  it('will not act on a witness that only heard part of the note', () => {
    const result = arbitrateRegister(
      [note(60, 0, 1)],
      [witness([[72, 0, 0.4]]), witness([[72, 0, 0.4]], 'game')],
    );
    expect(result.notes[0]?.pitch).toBe(60);
    expect(result.decisions[0]?.outcome).toBe('declined_partial');
    expect(result.unresolved).toBe(1);
  });

  it('will not act on a witness that could not settle on one pitch', () => {
    // Two octave-related readings of similar weight is not a clear claim about
    // anything, whichever of them happens to sort first.
    const result = arbitrateRegister(
      [note(60, 0, 1)],
      [
        witness([[72, 0, 0.65], [48, 0.05, 0.65]]),
        witness([[72, 0, 0.65], [48, 0.05, 0.65]], 'game'),
      ],
    );
    expect(result.notes[0]?.pitch).toBe(60);
    expect(result.decisions[0]?.outcome).toBe('declined_contested');
  });

  it('says nothing at all when no witness covered the note', () => {
    const result = arbitrateRegister([note(60, 5, 6)], [witness([[72, 0, 1]])]);
    expect(result.notes[0]?.pitch).toBe(60);
    expect(result.decisions[0]?.outcome).toBe('no_evidence');
    // Absence of evidence is not a disagreement.
    expect(result.unresolved).toBe(0);
  });

  it('ignores engines that are not trusted about register', () => {
    // The contour engine is the one whose register failure started this. It
    // must never be able to act as its own witness.
    expect(ENGINE_STRENGTHS['melody-contour'].register).toBeLessThan(0.5);
    const selfWitness: EvidenceSource = {
      engineId: 'melody-contour',
      view: 'original',
      notes: [{ pitch: 72, startSec: 0, endSec: 1 }],
    };
    const result = arbitrateRegister([note(60, 0, 1)], [selfWitness]);
    expect(result.notes[0]?.pitch).toBe(60);
    expect(result.decisions[0]?.outcome).toBe('no_evidence');
  });

  it('is a no-op when there are no witnesses at all', () => {
    // The normal case when the models are unavailable: the pipeline must behave
    // exactly as it did before, not merely nearly.
    const result = arbitrateRegister(LEAP_CANDIDATE, []);
    expect(result.notes).toEqual(LEAP_CANDIDATE);
    expect(result.corrected).toBe(0);
    expect(result.unresolved).toBe(0);
  });
});
