/**
 * The estimator has to be able to say "I don't know".
 *
 * ## What was wrong
 *
 * `estimatePerformanceTempo` returned `measured: true` for any take with four
 * onsets and a positive duration. That is a statement about arithmetic, not
 * about music: a grid search always has a winner, because some BPM always fits
 * better than the others.
 *
 * The consequence was measurable. All nine recordings in the benchmark corpus —
 * freely-sung melodic phrases — were given a precise BPM, and every one of them
 * scored between 0.32 and 0.43 confidence, below the floor at which the
 * interface is willing to state a tempo plainly. The product was publishing
 * four significant figures for pulses it did not believe in.
 *
 * ## Where the floor comes from
 *
 * Measured, not chosen. On synthesised material of known tempo:
 *
 *   metronomic            0.88 – 0.90
 *   ±20 ms jitter         0.85
 *   ±50 ms human jitter   0.77
 *   ±90 ms loose          0.62
 *   ±150 ms very loose    0.46   ← and already returns the *wrong* tempo:
 *                                  81.5 BPM for a 100 BPM source
 *   real corpus (all 9)   0.32 – 0.43
 *
 * `TEMPO_CONFIDENCE_FLOOR` (0.45) already sat in that gap. It gated how loudly
 * the interface spoke; it now also gates whether a tempo is asserted at all.
 *
 * The tests below pin both directions, because a floor that only abstains is as
 * broken as one that never does.
 */

import { describe, expect, it } from 'vitest';
import type { DrumEvent, NoteEvent } from '@contracts';
import {
  analyzeDrumRhythm,
  analyzeMelodyRhythm,
  encodingBpm,
  FREE_TIMING_ENCODING_BPM,
  planVersions,
  resolveVersionTempo,
  TEMPO_CONFIDENCE_FLOOR,
} from '@rhythm-extraction';

/** Notes on a grid, with controllable human error. */
function performance(bpm: number, count: number, jitterSec = 0): NoteEvent[] {
  const beat = 60 / bpm;
  return Array.from({ length: count }, (_, index) => {
    const wobble = jitterSec === 0 ? 0 : (((index * 37) % 11) / 10 - 0.5) * 2 * jitterSec;
    const startSec = Math.max(0, index * beat + wobble);
    return { startSec, endSec: startSec + beat * 0.8, pitch: 60 + (index % 5), velocity: 90 };
  });
}

/** A phrase with no pulse: durations and gaps chosen so nothing periodic fits. */
function rubato(): NoteEvent[] {
  const starts = [0, 0.31, 1.15, 1.42, 2.63, 2.79, 2.95, 4.4, 5.72, 5.9, 7.35, 7.51];
  return starts.map((startSec, index) => ({
    startSec,
    endSec: startSec + (index % 3 === 0 ? 0.9 : 0.22),
    pitch: 60 + (index % 4),
    velocity: 90,
  }));
}

describe('a steady performance still produces a tempo', () => {
  it('reports a metronomic take at its real tempo', () => {
    const rhythm = analyzeMelodyRhythm(performance(100, 16), (16 * 60) / 100);
    expect(rhythm.measured).toBe(true);
    expect(rhythm.tempo.bpm).toBeCloseTo(100, 0);
    expect(rhythm.tempo.mode).toBe('stable');
  });

  it('survives the timing error a person actually has', () => {
    // ±50 ms is ordinary human unsteadiness, not free timing. If this abstains,
    // the floor has been set somewhere that makes the feature useless.
    const rhythm = analyzeMelodyRhythm(performance(100, 16, 0.05), (16 * 60) / 100);
    expect(rhythm.measured).toBe(true);
    expect(rhythm.tempo.bpm).toBeCloseTo(100, 0);
    expect(rhythm.tempo.confidence).toBeGreaterThan(TEMPO_CONFIDENCE_FLOOR);
  });

  it('reaches the product as a real BPM', () => {
    const rhythm = analyzeMelodyRhythm(performance(120, 20), (20 * 60) / 120);
    const tempo = resolveVersionTempo({ rhythm });
    expect(tempo.freeTiming).toBe(false);
    expect(tempo.bpm).toBeCloseTo(120, 0);
    expect(encodingBpm(tempo)).toBeCloseTo(120, 0);
  });

  it('finds the pulse of a steady rhythm take too', () => {
    const hits: DrumEvent[] = Array.from({ length: 32 }, (_, index) => ({
      timeSec: index * 0.5,
      drum: 'kick',
      velocity: 100,
      confidence: 1,
    }));
    const rhythm = analyzeDrumRhythm(hits, 16);
    expect(rhythm.measured).toBe(true);
    expect(rhythm.tempo.bpm).toBeCloseTo(120, 0);
  });
});

describe('a performance without a pulse abstains', () => {
  const rhythm = analyzeMelodyRhythm(rubato(), 8.5);

  it('does not assert a tempo it cannot support', () => {
    expect(rhythm.tempo.confidence).toBeLessThan(TEMPO_CONFIDENCE_FLOOR);
    expect(rhythm.measured).toBe(false);
  });

  it('resolves to free timing with a null BPM', () => {
    const tempo = resolveVersionTempo({ rhythm });
    expect(tempo.bpm).toBeNull();
    expect(tempo.freeTiming).toBe(true);
  });

  it('says which kind of not-knowing it is', () => {
    // "Nothing to measure" and "a candidate nobody should trust" are different
    // observations, and a person reading the interface deserves the difference.
    expect(rhythm.tempo.mode).toBe('uncertain');
    expect(analyzeMelodyRhythm([], 5).tempo.mode).toBe('free');
  });

  it('quantizes nothing, which is the point of abstaining', () => {
    const plan = planVersions({ rhythm, mode: 'melody', amount: 100 });
    expect(plan.length).toBeGreaterThan(0);
    for (const version of plan) {
      expect(version.bpm).toBeNull();
      expect(version.freeTiming).toBe(true);
      expect(version.paramOverrides?.timingStrength).toBe(0);
    }
  });

  it('still writes a stable number where a file format demands one', () => {
    // A MIDI file must declare a tempo. It gets the constant, which is not a
    // claim about the performance, and no note is moved toward the grid it
    // implies.
    expect(encodingBpm(resolveVersionTempo({ rhythm }))).toBe(FREE_TIMING_ENCODING_BPM);
  });
});

describe('what abstention must not throw away', () => {
  it('keeps the candidate pulse visible instead of erasing it', () => {
    const rhythm = analyzeMelodyRhythm(rubato(), 8.5);
    // Abstaining is a decision not to *assert*, not a decision to forget. A
    // debug view or a future engine can still see what the grid search found.
    expect(rhythm.tempo.bpm).toBeGreaterThan(0);
    expect(rhythm.tempo.beats.length).toBeGreaterThan(0);
  });

  it('keeps a half/double disagreement inspectable', () => {
    // Events every 0.5 s fit 120 and 60 equally well. Whichever wins, the other
    // family must remain in the alternatives — silently collapsing a metrical
    // ambiguity is how a transcription ends up confidently half-speed.
    const rhythm = analyzeMelodyRhythm(performance(120, 24), 12);
    expect(rhythm.tempo.alternatives.length).toBeGreaterThan(0);
    for (const alternative of rhythm.tempo.alternatives) {
      expect(alternative.bpm).toBeGreaterThan(0);
    }
  });

  it('never lets an unbelieved estimate become a stated tempo', () => {
    // The invariant in one line: if it is not measured, the product does not
    // publish a number for it.
    for (const notes of [rubato(), performance(100, 16, 0.35)]) {
      const rhythm = analyzeMelodyRhythm(notes, 10);
      if (!rhythm.measured) expect(resolveVersionTempo({ rhythm }).bpm).toBeNull();
    }
  });

  it('an imported file\'s stated tempo still outranks all of this', () => {
    // A MIDI file asserting its own tempo is a fact about the music, and
    // abstention is about *inference*. The two must not be confused.
    const rhythm = analyzeMelodyRhythm(rubato(), 8.5);
    const tempo = resolveVersionTempo({ rhythm, statedBpm: 126 });
    expect(tempo.bpm).toBe(126);
    expect(tempo.freeTiming).toBe(false);
    expect(tempo.mode).toBe('stable');
  });
});
