/**
 * Where a version's tempo comes from.
 *
 * ## The bug these exist for
 *
 * From a real take: a person set the metronome to 103 BPM and then hummed an
 * idea nearer 88.5. The estimator measured it at ~88.5 with confidence 0.432 —
 * two hundredths below `TEMPO_CONFIDENCE_FLOOR` — and every downstream consumer
 * read `rhythm.reliable === false` as permission to use 103 instead. The
 * Musician was asked for a passage at 103, the versions played at 103, and the
 * exported MIDI was stamped 103. Nothing in the product ever said so.
 *
 * That was fixed once by making the arbitration correct. It is fixed again here
 * by removing the arbitration: there is no second candidate any more, because
 * the product no longer asks anyone for a tempo. A user reported the residue of
 * the old design plainly — the app saying "heard at 85, but you selected 120",
 * and the music coming out worse than when they had happened to select 85
 * before singing the same phrase.
 *
 * ## The second correction, and why the rule below changed again
 *
 * "Use the measurement at any confidence" fixed the substitution, and left a
 * different error in place: the estimator always returns a winner, because some
 * BPM always fits better than the others. Treating that as evidence that the
 * performance *has* a pulse gave every one of the nine benchmark recordings a
 * precise tempo, while not one of them scored above 0.43 confidence — below the
 * floor at which the interface is willing to state a tempo plainly. The product
 * was asserting pulses it did not believe in, on freely-sung material.
 *
 * So the rule under test is now:
 *
 *   the source stated its own tempo        -> that tempo, with certainty
 *   a pulse was found *and believed*       -> that pulse
 *   a winner exists but is not believable  -> free timing, bpm null
 *   nothing to measure at all              -> free timing, bpm null
 *
 * The original regression is unchanged and still asserted: uncertainty is not
 * evidence for some *other* number. What is added is that uncertainty is not
 * evidence for *this* number either — the honest response to "I am not sure
 * there is a pulse here" is to say so, not to publish four significant figures.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  analyzeMelodyRhythm,
  encodingBpm,
  FREE_TIMING_ENCODING_BPM,
  planVersions,
  resolveVersionTempo,
  TEMPO_CONFIDENCE_FLOOR,
} from '@rhythm-extraction';
import { buildMusicianRequest } from '@musician-client';
import type { VersionNoteSources } from '@versions';

/**
 * The metronome value from the original take.
 *
 * Kept as a number in this file for one reason: to assert that nothing the app
 * produces resembles it. There is no longer any input through which it could
 * reach the pipeline, which is what the type of `TempoResolutionInput` says and
 * what these tests confirm behaviourally.
 */
const ONCE_TAPPED_BPM = 103;
/** Roughly where the performance actually sat. */
const PERFORMED_BPM = 88.5;
const SOURCE_DURATION_SEC = 10.14;

/**
 * A hummed idea near 88.5 BPM, performed loosely enough that the estimator
 * measures it but is not sure of it.
 *
 * The looseness is deterministic pseudo-jitter rather than randomness, so a
 * failure here is reproducible and a change in the estimator shows up as a
 * changed number rather than a flaky test.
 */
function looselyHummedNotes(): NoteEvent[] {
  const beatSec = 60 / PERFORMED_BPM;
  const steps = [0, 1, 2, 3.5, 4, 5, 6.5, 7, 8, 9.5, 10, 11, 12];
  const jitterSec = 0.09;
  return steps.map((step, index) => {
    const wobble = (((index * 37) % 11) / 10 - 0.5) * 2 * jitterSec;
    const startSec = Math.max(0, step * beatSec + wobble);
    return { startSec, endSec: startSec + 0.4, pitch: 60 + (index % 5), velocity: 92 };
  });
}

/** Two notes: a take with nothing in it to establish a pulse from. */
function almostNothing(): NoteEvent[] {
  return [
    { startSec: 0.2, endSec: 0.9, pitch: 62, velocity: 90 },
    { startSec: 2.4, endSec: 3.1, pitch: 64, velocity: 88 },
  ];
}

function sourcesFor(notes: readonly NoteEvent[]): VersionNoteSources {
  return { unprocessed: notes, generated: {} };
}

describe('the fixture this regression is built on', () => {
  const rhythm = analyzeMelodyRhythm(looselyHummedNotes(), SOURCE_DURATION_SEC);

  it('finds a candidate near the performed tempo', () => {
    // Deliberately loose. The invariant under test is the *source* of the tempo,
    // not one magic number, and pinning 88.5 exactly would make a legitimate
    // estimator improvement look like a regression.
    expect(Math.abs(rhythm.tempo.bpm - PERFORMED_BPM)).toBeLessThanOrEqual(4);
  });

  it('does not believe it, because the performance is too loose', () => {
    // The fixture was built to sit just under the floor, and that is now the
    // difference between a candidate and an assertion.
    expect(rhythm.measured).toBe(false);
    expect(rhythm.tempo.mode).toBe('uncertain');
  });

  it('is confident about it only just below the floor', () => {
    // This is the whole point of the fixture: it sits in the band where the old
    // code silently swapped in the metronome.
    expect(rhythm.tempo.confidence).toBeLessThan(TEMPO_CONFIDENCE_FLOOR);
    expect(rhythm.tempo.confidence).toBeGreaterThan(0.3);
    expect(rhythm.reliable).toBe(false);
  });
});

describe('a measured but uncertain tempo', () => {
  const notes = looselyHummedNotes();
  const rhythm = analyzeMelodyRhythm(notes, SOURCE_DURATION_SEC);

  it('is not asserted as the performance\'s tempo', () => {
    const tempo = resolveVersionTempo({ rhythm });
    expect(tempo.bpm).toBeNull();
    expect(tempo.freeTiming).toBe(true);
    expect(tempo.mode).toBe('uncertain');
  });

  it('still resembles nothing like the old tapped value', () => {
    // The original regression, and it must survive every later change: the
    // estimator's candidate is near what was performed, not near what was once
    // typed into a metronome. Abstaining is not a licence to drift back.
    expect(Math.abs(rhythm.tempo.bpm - ONCE_TAPPED_BPM)).toBeGreaterThan(5);
  });

  it('reports its confidence as measured rather than rewriting it', () => {
    const tempo = resolveVersionTempo({ rhythm });
    expect(tempo.confidence).toBe(rhythm.tempo.confidence);
    expect(tempo.confidence).toBeLessThan(TEMPO_CONFIDENCE_FLOOR);
    // Uncertainty is preserved as uncertainty. It is what the picker hedges on.
    expect(tempo.reliable).toBe(false);
  });

  it('leaves every version freely timed rather than on an unbelieved grid', () => {
    const plan = planVersions({
      rhythm,
      mode: 'melody',
      amount: 55,
      generated: ['musician-refined', 'musician-developed', 'musician-expanded'],
    });
    expect(plan.length).toBe(4);
    for (const version of plan) {
      expect(version.bpm).toBeNull();
      expect(version.freeTiming).toBe(true);
      // And therefore nothing quantizes: the whole point of abstaining is that
      // no note is pulled onto a grid nobody could hear.
      expect(version.paramOverrides?.timingStrength).toBe(0);
      expect(version.tempoConfidence).toBe(rhythm.tempo.confidence);
    }
  });

  it('reaches the Musician as the encoding constant, not as a claimed tempo', () => {
    const tempo = resolveVersionTempo({ rhythm });
    const request = buildMusicianRequest({
      sourceId: 'sketch-1',
      versionNotes: sourcesFor(notes),
      tempo: { bpm: encodingBpm(tempo), confidence: tempo.confidence },
      meter: { beatsPerBar: 4, beatUnit: 4 },
      key: null,
      sourceDurationSec: SOURCE_DURATION_SEC,
    });
    expect(request).not.toBeNull();
    // The service needs a number to condition on. It gets the free-timing
    // constant, which is not a claim about this performance — and never the
    // tapped 103, which is the regression this file was written for.
    expect(request?.bpm).toBe(FREE_TIMING_ENCODING_BPM);
    expect(request?.bpm).not.toBe(ONCE_TAPPED_BPM);
    expect(request?.tempoConfidence).toBe(rhythm.tempo.confidence);
    expect(request?.tempoConfidence).not.toBe(0.4);
  });

  it('sends the source duration, not a length budget for the result', () => {
    const tempo = resolveVersionTempo({ rhythm });
    const request = buildMusicianRequest({
      sourceId: 'sketch-1',
      versionNotes: sourcesFor(notes),
      tempo: { bpm: encodingBpm(tempo), confidence: tempo.confidence },
      meter: { beatsPerBar: 4, beatUnit: 4 },
      key: null,
      sourceDurationSec: SOURCE_DURATION_SEC,
    });
    expect(request?.durationSec).toBe(SOURCE_DURATION_SEC);
  });
});

describe('a source that states its own tempo', () => {
  // A MIDI file carries a tempo map. That is the file asserting a fact about
  // the music, which is a different kind of thing from a number somebody set on
  // a click track before performing — and it is the only way a tempo can enter
  // the pipeline other than by being measured.
  const notes = looselyHummedNotes();
  const rhythm = analyzeMelodyRhythm(notes, SOURCE_DURATION_SEC);
  const STATED_BPM = 126;

  it('uses the stated tempo rather than re-deriving one from the notes', () => {
    // The regression: estimating from an imported file's own note starts is
    // deriving a worse answer to a question the file already answered exactly.
    // A 126 BPM file measured 120, and the exported MIDI came back stamped with
    // a tempo the source never had.
    const tempo = resolveVersionTempo({ rhythm, statedBpm: STATED_BPM });
    expect(tempo.bpm).toBe(STATED_BPM);
    expect(tempo.freeTiming).toBe(false);
    expect(encodingBpm(tempo)).toBe(STATED_BPM);
  });

  it('is certain about it, because it was not inferred', () => {
    const tempo = resolveVersionTempo({ rhythm, statedBpm: STATED_BPM });
    expect(tempo.confidence).toBe(1);
    expect(tempo.reliable).toBe(true);
  });

  it('carries it to every version', () => {
    const plan = planVersions({ rhythm, statedBpm: STATED_BPM, mode: 'melody', amount: 55 });
    expect(plan.length).toBeGreaterThan(0);
    for (const version of plan) {
      expect(version.bpm).toBe(STATED_BPM);
      expect(version.freeTiming).toBe(false);
    }
  });

  it('ignores a stated tempo that is not a number', () => {
    // Absent, null and NaN are all "the source said nothing", which is the
    // normal case: everything recorded or uploaded as audio states no tempo.
    for (const stated of [undefined, null, Number.NaN]) {
      const tempo = resolveVersionTempo({ rhythm, statedBpm: stated });
      // This fixture is too loose to assert a tempo of its own, so "the source
      // said nothing" resolves to free timing rather than to the estimate.
      expect({ stated, bpm: tempo.bpm }).toEqual({ stated, bpm: null });
    }
  });
});

describe('a take with no measurable pulse', () => {
  const rhythm = analyzeMelodyRhythm(almostNothing(), 3.5);

  it('is reported as unmeasured rather than as a low-confidence guess', () => {
    // Not the same state as "uncertain". Pretending an estimate exists here
    // would be the mirror image of the bug above: claiming a reading nobody took.
    expect(rhythm.measured).toBe(false);
    expect(rhythm.reliable).toBe(false);
    expect(rhythm.tempo.confidence).toBe(0);
  });

  it('is free timing, not a substituted number', () => {
    const tempo = resolveVersionTempo({ rhythm });
    // The old behaviour reached for the metronome here — the one case where it
    // did so without being asked. There is nothing to reach for now.
    expect(tempo.bpm).toBeNull();
    expect(tempo.freeTiming).toBe(true);
    expect(tempo.reliable).toBe(false);
  });

  it('encodes at a constant that no version is allowed to quantize to', () => {
    const tempo = resolveVersionTempo({ rhythm });
    // A MIDI file must state a tempo and a bar ruler must space its lines, so a
    // number still has to exist. What makes it harmless is that every version
    // built on a free-timed take carries zero timing strength, so the grid this
    // constant implies never moves a note.
    expect(encodingBpm(tempo)).toBe(FREE_TIMING_ENCODING_BPM);

    const plan = planVersions({ rhythm, mode: 'melody', amount: 100 });
    expect(plan.length).toBeGreaterThan(0);
    for (const version of plan) {
      expect(version.bpm).toBeNull();
      expect(version.freeTiming).toBe(true);
      expect(version.paramOverrides?.timingStrength).toBe(0);
    }
  });
});
