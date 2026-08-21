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
 * The metronome is a recording guide. A performance hummed at 88.5 is at 88.5
 * whether or not the estimator is sure of the number, and uncertainty about a
 * measurement is not evidence for a different measurement.
 *
 * So the rule under test is: **a measured pulse is used at any confidence**; the
 * tapped value is only reached for when there was nothing to measure at all, or
 * when the user explicitly asks for it.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  analyzeMelodyRhythm,
  compareTempos,
  planVersions,
  resolveVersionTempo,
  TEMPO_CONFIDENCE_FLOOR,
} from '@rhythm-extraction';
import { buildMusicianRequest } from '@musician-client';
import type { VersionNoteSources } from '@versions';

/** The metronome value for the take these tests reconstruct. */
const TAPPED_BPM = 103;
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
  return { unprocessed: notes, judge: notes, teacher: notes, generated: {} };
}

describe('the fixture this regression is built on', () => {
  const rhythm = analyzeMelodyRhythm(looselyHummedNotes(), SOURCE_DURATION_SEC);

  it('measures a tempo near the performed one', () => {
    // Deliberately loose. The invariant under test is the *source* of the tempo,
    // not one magic number, and pinning 88.5 exactly would make a legitimate
    // estimator improvement look like a regression.
    expect(rhythm.measured).toBe(true);
    expect(Math.abs(rhythm.tempo.bpm - PERFORMED_BPM)).toBeLessThanOrEqual(4);
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

  it('stays the musical interpretation rather than becoming the metronome', () => {
    const tempo = resolveVersionTempo({ rhythm, tappedBpm: TAPPED_BPM });
    expect(tempo.source).toBe('detected');
    expect(tempo.bpm).toBe(rhythm.tempo.bpm);
    // The failing assertion under the old behaviour.
    expect(Math.abs(tempo.bpm - TAPPED_BPM)).toBeGreaterThan(5);
  });

  it('reports its confidence as measured rather than rewriting it', () => {
    const tempo = resolveVersionTempo({ rhythm, tappedBpm: TAPPED_BPM });
    expect(tempo.confidence).toBe(rhythm.tempo.confidence);
    expect(tempo.confidence).toBeLessThan(TEMPO_CONFIDENCE_FLOOR);
    // Uncertainty is preserved as uncertainty. It is what the picker hedges on.
    expect(tempo.reliable).toBe(false);
    expect(tempo.fellBackForLackOfEvidence).toBe(false);
  });

  it('builds every version on it, including the Musician versions', () => {
    const plan = planVersions({
      rhythm,
      tappedBpm: TAPPED_BPM,
      mode: 'melody',
      amount: 55,
      generated: ['musician-refined', 'musician-developed', 'musician-expanded'],
    });
    expect(plan.length).toBe(6);
    for (const version of plan) {
      expect(version.tempoSource).toBe('detected');
      expect(Math.abs(version.bpm - rhythm.tempo.bpm)).toBeLessThan(0.001);
      // The hedge travels with the version so the picker can say "about".
      expect(version.tempoReliable).toBe(false);
      expect(version.tempoConfidence).toBe(rhythm.tempo.confidence);
    }
  });

  it('is what the Musician is asked for, at its real confidence', () => {
    const request = buildMusicianRequest({
      sourceId: 'sketch-1',
      versionNotes: sourcesFor(notes),
      tempo: resolveVersionTempo({ rhythm, tappedBpm: TAPPED_BPM }),
      meter: { beatsPerBar: 4, beatUnit: 4 },
      key: null,
      sourceDurationSec: SOURCE_DURATION_SEC,
    });
    expect(request).not.toBeNull();
    // Both of these failed before: the bpm was 103, and the confidence was a
    // hard-coded 0.4 describing neither number.
    expect(request?.bpm).toBe(rhythm.tempo.bpm);
    expect(request?.bpm).not.toBe(TAPPED_BPM);
    expect(request?.tempoConfidence).toBe(rhythm.tempo.confidence);
    expect(request?.tempoConfidence).not.toBe(0.4);
  });

  it('sends the source duration, not a length budget for the result', () => {
    const request = buildMusicianRequest({
      sourceId: 'sketch-1',
      versionNotes: sourcesFor(notes),
      tempo: resolveVersionTempo({ rhythm, tappedBpm: TAPPED_BPM }),
      meter: { beatsPerBar: 4, beatUnit: 4 },
      key: null,
      sourceDurationSec: SOURCE_DURATION_SEC,
    });
    expect(request?.durationSec).toBe(SOURCE_DURATION_SEC);
  });

  it('still says the two tempos disagree, hedged rather than hidden', () => {
    // Previously suppressed entirely below the floor — in exactly the case where
    // the app had quietly switched to the tapped value, so the user saw neither
    // the substitution nor a reason to doubt it.
    const disagreement = compareTempos(rhythm, TAPPED_BPM);
    expect(disagreement.kind).not.toBe('none');
    expect(disagreement.detectedIsReliable).toBe(false);
    expect(Math.round(disagreement.tappedBpm)).toBe(TAPPED_BPM);
  });
});

describe('the tapped tempo', () => {
  const notes = looselyHummedNotes();
  const rhythm = analyzeMelodyRhythm(notes, SOURCE_DURATION_SEC);

  it('remains available beside the detected one', () => {
    // It is never discarded: the metronome still needs it, and the picker shows
    // both figures so the user can tell them apart.
    const disagreement = compareTempos(rhythm, TAPPED_BPM);
    expect(disagreement.tappedBpm).toBe(TAPPED_BPM);
    expect(Math.abs(disagreement.detectedBpm - PERFORMED_BPM)).toBeLessThanOrEqual(4);
  });

  it('becomes the musical tempo when the user asks for it, and only then', () => {
    const chosen = resolveVersionTempo({
      rhythm,
      tappedBpm: TAPPED_BPM,
      tempoChoice: 'metronome',
    });
    expect(chosen.source).toBe('tapped');
    expect(chosen.bpm).toBe(TAPPED_BPM);
    // Not a fallback: there was a good measurement and the user overruled it.
    expect(chosen.fellBackForLackOfEvidence).toBe(false);
    // The estimator's confidence is still reported as what it measured.
    expect(chosen.confidence).toBe(rhythm.tempo.confidence);

    const plan = planVersions({
      rhythm,
      tappedBpm: TAPPED_BPM,
      tempoChoice: 'metronome',
      mode: 'melody',
      amount: 55,
    });
    for (const version of plan) {
      expect(version.bpm).toBe(TAPPED_BPM);
      expect(version.tempoSource).toBe('tapped');
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

  it('is the one case where the tapped tempo is used without being asked for', () => {
    const tempo = resolveVersionTempo({ rhythm, tappedBpm: TAPPED_BPM });
    expect(tempo.source).toBe('tapped');
    expect(tempo.bpm).toBe(TAPPED_BPM);
    // Flagged, so the UI says "no pulse could be heard" rather than implying
    // the app heard 103.
    expect(tempo.fellBackForLackOfEvidence).toBe(true);
    expect(tempo.reliable).toBe(false);
  });

  it('says nothing about a tempo disagreement it cannot have an opinion on', () => {
    expect(compareTempos(rhythm, TAPPED_BPM).kind).toBe('none');
  });
});
