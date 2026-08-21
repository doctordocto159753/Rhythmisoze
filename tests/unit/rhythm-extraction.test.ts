/**
 * Tempo detected from the performance, not imposed by the metronome.
 *
 * The acceptance criterion these exist for, quoted from the brief:
 *
 *   > Given: user records at 83 BPM. Metronome: 120 BPM.
 *   > Expected: detected BPM approximately 83. NOT 120.
 *
 * The old estimator could not do this, and the reason is worth keeping in
 * front of whoever changes this next: it anchored its grid at t=0 and had no
 * preference between a tempo and its double. Both failures are tested here
 * directly, so a regression shows up as the specific fault rather than as a
 * vague accuracy drop.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  analyzeGroove,
  analyzeMelodyRhythm,
  compareTempos,
  defaultVersion,
  estimateMeter,
  estimatePerformanceTempo,
  isSameTempoFamily,
  melodyOnsets,
  planVersions,
  tempoResonance,
  VERSION_IDS,
  type WeightedOnset,
} from '@rhythm-extraction';

/** A performance at `bpm`, one note per `subdivision` of a beat. */
function performance(options: {
  bpm: number;
  beats: number;
  startAt?: number;
  jitterSec?: number;
  subdivision?: number;
}): WeightedOnset[] {
  const { bpm, beats, startAt = 0, jitterSec = 0, subdivision = 1 } = options;
  const beatSec = 60 / bpm;
  const stepSec = beatSec / subdivision;
  const onsets: WeightedOnset[] = [];
  for (let i = 0; i < beats * subdivision; i += 1) {
    // Deterministic pseudo-jitter, so a failure is reproducible.
    const wobble = jitterSec === 0 ? 0 : (((i * 37) % 11) / 10 - 0.5) * 2 * jitterSec;
    onsets.push({ timeSec: startAt + i * stepSec + wobble, weight: i % subdivision === 0 ? 1 : 0.6 });
  }
  return onsets;
}

describe('tempo detection', () => {
  it.each([60, 72, 83, 96, 110, 128, 144])(
    'recovers a steady performance at %i BPM',
    (bpm) => {
      const onsets = performance({ bpm, beats: 16 });
      const result = estimatePerformanceTempo(onsets, (16 * 60) / bpm);
      expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(2);
      expect(result.confidence).toBeGreaterThan(0.45);
    },
  );

  it('detects 83 BPM from a take performed at 83, whatever the metronome said', () => {
    // The brief's acceptance criterion, verbatim.
    const onsets = performance({ bpm: 83, beats: 20, jitterSec: 0.012 });
    const result = estimatePerformanceTempo(onsets, (20 * 60) / 83);
    expect(Math.abs(result.bpm - 83)).toBeLessThanOrEqual(2);
    expect(result.bpm).not.toBeCloseTo(120, 0);
  });

  it('is not fooled by a performance that does not start on a beat', () => {
    // The old estimator assumed phase zero and failed exactly here.
    const offset = (60 / 96) * 0.37;
    const onsets = performance({ bpm: 96, beats: 16, startAt: offset });
    const result = estimatePerformanceTempo(onsets, 12);
    expect(Math.abs(result.bpm - 96)).toBeLessThanOrEqual(2);
    // And it should recover the offset rather than merely tolerating it.
    const beatSec = 60 / result.bpm;
    const phaseError = Math.abs(((result.phaseSec - offset) % beatSec) / beatSec);
    expect(Math.min(phaseError, 1 - phaseError)).toBeLessThan(0.15);
  });

  it('survives human timing jitter', () => {
    const onsets = performance({ bpm: 100, beats: 24, jitterSec: 0.035 });
    const result = estimatePerformanceTempo(onsets, 14.4);
    expect(Math.abs(result.bpm - 100)).toBeLessThanOrEqual(3);
  });

  it('prefers the perceptually plausible tempo over its double', () => {
    // Eighth notes at 70 BPM also fit 140 BPM perfectly. A listener hears 70.
    const onsets = performance({ bpm: 70, beats: 16, subdivision: 2 });
    const result = estimatePerformanceTempo(onsets, 13.7);
    expect(isSameTempoFamily(result.bpm, 70)).toBe(true);
  });

  it('reports low confidence rather than a guess when there is nothing to hear', () => {
    const result = estimatePerformanceTempo([], 5);
    expect(result.confidence).toBe(0);
    expect(result.beats).toEqual([]);
  });

  it('refuses to estimate from too few onsets', () => {
    const onsets = performance({ bpm: 120, beats: 3 });
    expect(estimatePerformanceTempo(onsets, 1.5).confidence).toBe(0);
  });

  it('stays inside the PRD tempo range', () => {
    for (const bpm of [30, 45, 190, 260]) {
      const result = estimatePerformanceTempo(performance({ bpm, beats: 16 }), 20);
      expect(result.bpm).toBeGreaterThanOrEqual(40);
      expect(result.bpm).toBeLessThanOrEqual(200);
    }
  });

  it('produces a beat grid that covers the clip', () => {
    const result = estimatePerformanceTempo(performance({ bpm: 120, beats: 8 }), 4);
    expect(result.beats.length).toBeGreaterThan(6);
    expect(result.beats[0]).toBeGreaterThanOrEqual(0);
    expect(result.beats[result.beats.length - 1]).toBeLessThanOrEqual(4.001);
  });

  it('is deterministic', () => {
    const onsets = performance({ bpm: 91, beats: 16, jitterSec: 0.02 });
    expect(estimatePerformanceTempo(onsets, 10)).toEqual(estimatePerformanceTempo(onsets, 10));
  });
});

describe('tempo resonance', () => {
  it('peaks near the middle of the human comfortable range', () => {
    expect(tempoResonance(110)).toBeGreaterThan(tempoResonance(55));
    expect(tempoResonance(110)).toBeGreaterThan(tempoResonance(200));
  });

  it('is symmetric in ratio, not in difference', () => {
    // 55 and 220 are both two octaves from 110 and should score alike.
    expect(Math.abs(tempoResonance(55) - tempoResonance(220))).toBeLessThan(0.02);
  });
});

describe('meter', () => {
  it('finds four-four when downbeats are accented', () => {
    const beatSec = 0.5;
    const onsets: WeightedOnset[] = [];
    for (let i = 0; i < 16; i += 1) {
      onsets.push({ timeSec: i * beatSec, weight: i % 4 === 0 ? 1 : 0.35 });
    }
    const beats = Array.from({ length: 16 }, (_, i) => i * beatSec);
    const meter = estimateMeter(onsets, beats, beatSec);
    expect(meter.beatsPerBar).toBe(4);
    expect(meter.downbeatOffset).toBe(0);
  });

  it('falls back to four rather than guessing from nothing', () => {
    expect(estimateMeter([], [], 0.5).beatsPerBar).toBe(4);
    expect(estimateMeter([], [], 0.5).confidence).toBe(0);
  });
});

describe('groove', () => {
  it('calls a metronomic performance steady', () => {
    const groove = analyzeGroove(performance({ bpm: 120, beats: 16 }), 120, 0);
    expect(groove.steadiness).toBeGreaterThan(0.9);
    expect(Math.abs(groove.deviationBeats)).toBeLessThan(0.02);
  });

  it('calls a loose performance loose', () => {
    const groove = analyzeGroove(
      performance({ bpm: 120, beats: 16, jitterSec: 0.08 }),
      120,
      0,
    );
    expect(groove.steadiness).toBeLessThan(0.75);
  });

  it('declines to report swing without enough off-beats', () => {
    expect(analyzeGroove(performance({ bpm: 120, beats: 4 }), 120, 0).swingRatio).toBeNull();
  });
});

describe('version planning', () => {
  const notes: NoteEvent[] = Array.from({ length: 16 }, (_, i) => ({
    startSec: i * (60 / 96),
    endSec: i * (60 / 96) + 0.4,
    pitch: 60 + (i % 5),
    velocity: 90,
  }));
  const rhythm = analyzeMelodyRhythm(notes, 10);

  it('offers the three local versions without the Musician', () => {
    // The Musician is optional and may never have run, so the default plan is
    // the three versions that can always be derived from the transcription.
    // Offering more would put an unplayable entry in the picker.
    const plan = planVersions({ rhythm, tappedBpm: 120, mode: 'melody', amount: 55 });
    expect(plan.map((version) => version.id)).toEqual(['unprocessed', 'judge', 'teacher']);
  });

  it('adds a Musician version only once its notes exist', () => {
    const plan = planVersions({
      rhythm,
      tappedBpm: 120,
      mode: 'melody',
      amount: 55,
      generated: ['musician-refined'],
    });
    expect(plan.map((version) => version.id)).toEqual([
      'unprocessed',
      'judge',
      'teacher',
      'musician-refined',
    ]);
    // Its partner was not generated, so it is not offered.
    expect(plan.map((version) => version.id)).not.toContain('musician-developed');
  });

  it('leaves Musician timing alone', () => {
    // These notes are a model's explicit, recorded decisions about pitch and
    // timing. Quantising on top of them would overwrite those decisions with an
    // unexplained grid, and the stored provenance would then describe something
    // the user never heard.
    const plan = planVersions({
      rhythm,
      tappedBpm: 120,
      mode: 'melody',
      amount: 55,
      generated: ['musician-refined', 'musician-developed'],
    });
    for (const version of plan.filter((entry) => entry.id.startsWith('musician-'))) {
      expect(version.amount).toBe(0);
      expect(version.paramOverrides?.timingStrength).toBe(0);
      expect(version.paramOverrides?.scaleSnapStrength).toBe(0);
    }
  });

  it('builds every version on the detected tempo when one was heard', () => {
    const plan = planVersions({ rhythm, tappedBpm: 120, mode: 'melody', amount: 55 });
    for (const version of plan) {
      expect(version.tempoSource).toBe('detected');
      expect(Math.abs(version.bpm - 96)).toBeLessThanOrEqual(3);
    }
  });

  it('never quantizes or re-pitches the unprocessed version', () => {
    const plan = planVersions({ rhythm, tappedBpm: 120, mode: 'melody', amount: 100 });
    const raw = plan.find((version) => version.id === 'unprocessed');
    // The whole promise: the original survives even at full cleanup.
    expect(raw?.paramOverrides?.timingStrength).toBe(0);
    expect(raw?.paramOverrides?.scaleSnapStrength).toBe(0);
    expect(raw?.amount).toBe(0);
  });

  it('leaves pitch alone in the Judge version', () => {
    // The Judge answers "what did they play", not "what should it have been".
    // Snapping to a scale there would be the Teacher's job done in the wrong
    // place, and would make the faithfulness score unmeasurable.
    const plan = planVersions({ rhythm, tappedBpm: 120, mode: 'melody', amount: 100 });
    expect(plan.find((v) => v.id === 'judge')?.paramOverrides?.scaleSnapStrength).toBe(0);
  });

  it('increases timing correction monotonically across the versions', () => {
    const plan = planVersions({ rhythm, tappedBpm: 120, mode: 'melody', amount: 55 });
    const strengths = plan.map((version) => version.paramOverrides?.timingStrength ?? 0);
    for (let i = 1; i < strengths.length; i += 1) {
      expect(strengths[i] as number).toBeGreaterThanOrEqual(strengths[i - 1] as number);
    }
  });

  it('falls back to the tapped tempo when detection is unreliable', () => {
    const sparse = analyzeMelodyRhythm(notes.slice(0, 2), 2);
    const plan = planVersions({ rhythm: sparse, tappedBpm: 132, mode: 'melody', amount: 55 });
    for (const version of plan) {
      expect(version.bpm).toBe(132);
      expect(version.tempoSource).toBe('tapped');
    }
  });

  it('defaults to the Judge reading', () => {
    // The most faithful account of what the person did is what they came to
    // hear; the Teacher is a step they take, not one taken for them.
    expect(defaultVersion(rhythm)).toBe('judge');
  });
});

describe('tempo disagreement', () => {
  const notes: NoteEvent[] = Array.from({ length: 16 }, (_, i) => ({
    startSec: i * (60 / 80),
    endSec: i * (60 / 80) + 0.4,
    pitch: 62,
    velocity: 90,
  }));
  const rhythm = analyzeMelodyRhythm(notes, 12);

  it('recognises a half-or-double tap as the common mistake it is', () => {
    expect(compareTempos(rhythm, 160).kind).toBe('half-or-double');
  });

  it('stays quiet when the tap agrees', () => {
    expect(compareTempos(rhythm, 80).kind).toBe('none');
  });

  it('says nothing when detection is unreliable', () => {
    const sparse = analyzeMelodyRhythm(notes.slice(0, 2), 2);
    expect(compareTempos(sparse, 200).kind).toBe('none');
  });
});

describe('onset weighting', () => {
  it('gives a long loud note more rhythmic authority than a short quiet one', () => {
    const [long, short] = melodyOnsets([
      { startSec: 0, endSec: 1.5, pitch: 60, velocity: 120 },
      { startSec: 2, endSec: 2.05, pitch: 60, velocity: 30 },
    ]);
    expect((long as WeightedOnset).weight).toBeGreaterThan((short as WeightedOnset).weight);
  });
});
