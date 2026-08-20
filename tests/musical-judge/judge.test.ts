/**
 * The Musical Judge, tested against the failures that motivated it.
 *
 * Each case builds a synthesised hum with a *known* correct transcription, then
 * hands the Judge a deliberately corrupted version of it and asserts that the
 * corruption is detected and undone.
 *
 * That structure matters: the assertion is never "the score went up", which any
 * scoring function can be made to satisfy. It is "the specific wrong note is
 * gone" or "the note is back in the octave the human actually sang".
 */

import { describe, expect, it } from 'vitest';
import type { MonoAudio, NoteEvent } from '@contracts';
import {
  extractJudgeFeatures,
  judgeAndRepair,
  judgeNotes,
  correctOctaves,
  isOctaveApart,
  mergeFragments,
  reconstructDurations,
  removeUnsupportedNotes,
  bandedDtw,
  type JudgeFeatures,
} from '@musical-judge';

const RATE = 44100;

/** Notes of the reference phrase: A3 B3 C4 D4 E4, half a second each. */
const PHRASE: ReadonlyArray<{ hz: number; midi: number }> = [
  { hz: 220.0, midi: 57 },
  { hz: 246.94, midi: 59 },
  { hz: 261.63, midi: 60 },
  { hz: 293.66, midi: 62 },
  { hz: 329.63, midi: 64 },
];

const NOTE_SEC = 0.5;
const GAP_SEC = 0.08;

/**
 * A sung phrase with a real fundamental and two harmonics.
 *
 * The harmonics are the point: a pitch tracker that latches onto the second
 * harmonic reports a note an octave too high, which is exactly the octave error
 * the Judge has to detect.
 */
function hummedPhrase(): MonoAudio {
  const step = NOTE_SEC + GAP_SEC;
  const total = Math.round(PHRASE.length * step * RATE);
  const out = new Float32Array(total);

  PHRASE.forEach((note, index) => {
    const start = Math.round(index * step * RATE);
    const length = Math.round(NOTE_SEC * RATE);
    let phase = 0;
    for (let i = 0; i < length && start + i < total; i += 1) {
      const t = i / RATE;
      const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t);
      phase += (2 * Math.PI * note.hz * vibrato) / RATE;
      const envelope = Math.min(1, t / 0.03) * Math.min(1, (NOTE_SEC - t) / 0.06);
      out[start + i] =
        0.5 * envelope * (Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase));
    }
  });

  return { samples: out, sampleRate: RATE, durationSec: total / RATE };
}

/** The transcription a perfect engine would produce for `hummedPhrase()`. */
function correctNotes(): NoteEvent[] {
  const step = NOTE_SEC + GAP_SEC;
  return PHRASE.map((note, index) => ({
    startSec: index * step,
    endSec: index * step + NOTE_SEC,
    pitch: note.midi,
    velocity: 90,
  }));
}

const audio = hummedPhrase();
const features: JudgeFeatures = extractJudgeFeatures(audio);

describe('feature extraction', () => {
  it('finds voiced audio to judge against', () => {
    expect(features.voicedFrames).toBeGreaterThan(50);
    expect(features.durationSec).toBeGreaterThan(2);
  });

  it('recovers the sung pitches, so the reference is trustworthy', () => {
    // If this fails, every other assertion in the file is meaningless.
    const step = NOTE_SEC + GAP_SEC;
    PHRASE.forEach((note, index) => {
      const middle = index * step + NOTE_SEC / 2;
      const frame = features.frames.find((f) => Math.abs(f.timeSec - middle) < 0.02);
      expect(frame?.midiPitch).toBeDefined();
      expect(Math.abs((frame?.midiPitch ?? 0) - note.midi)).toBeLessThan(1);
    });
  });
});

describe('scoring', () => {
  it('scores a correct transcription highly', () => {
    const score = judgeNotes(correctNotes(), features);
    expect(score.overall).toBeGreaterThan(0.8);
    expect(score.diagnostics.unsupportedNotes).toBe(0);
  });

  it('scores a fabricated note as unsupported', () => {
    const withGhost = [
      ...correctNotes(),
      // A note at a pitch the human never sang, over audio that was voiced.
      { startSec: 0.1, endSec: 0.4, pitch: 71, velocity: 80 },
    ];
    const score = judgeNotes(withGhost, features);
    expect(score.diagnostics.unsupportedNotes).toBeGreaterThan(0);
    expect(score.parsimony).toBeLessThan(1);
    expect(score.overall).toBeLessThan(judgeNotes(correctNotes(), features).overall);
  });

  it('counts an octave error separately from an ordinary wrong note', () => {
    const notes = correctNotes();
    notes[0] = { ...(notes[0] as NoteEvent), pitch: 45 }; // A2 instead of A3
    expect(judgeNotes(notes, features).diagnostics.octaveMismatches).toBe(1);
  });

  it('penalises fragmentation', () => {
    const fragments: NoteEvent[] = [
      { startSec: 0.0, endSec: 0.12, pitch: 57, velocity: 90 },
      { startSec: 0.14, endSec: 0.28, pitch: 57, velocity: 90 },
      { startSec: 0.3, endSec: 0.5, pitch: 57, velocity: 90 },
    ];
    const whole: NoteEvent[] = [{ startSec: 0, endSec: 0.5, pitch: 57, velocity: 90 }];
    expect(judgeNotes(fragments, features).fragmentation).toBeLessThan(
      judgeNotes(whole, features).fragmentation,
    );
  });

  it('abstains rather than inventing an opinion about silence', () => {
    const silent = extractJudgeFeatures({
      samples: new Float32Array(RATE),
      sampleRate: RATE,
      durationSec: 1,
    });
    const score = judgeNotes(correctNotes(), silent);
    expect(score.overall).toBe(0.5);
  });

  it('is deterministic', () => {
    expect(judgeNotes(correctNotes(), features)).toEqual(judgeNotes(correctNotes(), features));
  });
});

describe('octave detection', () => {
  it('recognises exact octave relationships', () => {
    expect(isOctaveApart(45, 57)).toBe(true);
    expect(isOctaveApart(57, 81)).toBe(true);
    expect(isOctaveApart(57, 59)).toBe(false);
    // A twelfth is not an octave, and must not be silently "corrected".
    expect(isOctaveApart(57, 64)).toBe(false);
  });
});

describe('repair operators', () => {
  it('removes a note the audio never contained', () => {
    const withGhost = [
      ...correctNotes(),
      { startSec: 0.1, endSec: 0.4, pitch: 71, velocity: 80 },
    ];
    const repaired = removeUnsupportedNotes(withGhost, features);
    expect(repaired.some((note) => note.pitch === 71)).toBe(false);
    // And it must not take the real notes with it.
    expect(repaired.length).toBe(correctNotes().length);
  });

  it('moves an octave-slipped note back to the sung octave', () => {
    const notes = correctNotes();
    notes[0] = { ...(notes[0] as NoteEvent), pitch: 45 };
    const repaired = correctOctaves(notes, features);
    expect((repaired[0] as NoteEvent).pitch).toBe(57);
  });

  it('leaves a correct note alone', () => {
    const notes = correctNotes();
    expect(correctOctaves(notes, features).map((n) => n.pitch)).toEqual(notes.map((n) => n.pitch));
  });

  it('merges a note split into three', () => {
    const fragments: NoteEvent[] = [
      { startSec: 0.0, endSec: 0.12, pitch: 57, velocity: 80 },
      { startSec: 0.14, endSec: 0.28, pitch: 57, velocity: 95 },
      { startSec: 0.3, endSec: 0.5, pitch: 57, velocity: 88 },
    ];
    const merged = mergeFragments(fragments, features);
    expect(merged).toHaveLength(1);
    expect((merged[0] as NoteEvent).startSec).toBeCloseTo(0, 6);
    expect((merged[0] as NoteEvent).endSec).toBeCloseTo(0.5, 6);
    // The loudest fragment's velocity survives.
    expect((merged[0] as NoteEvent).velocity).toBe(95);
  });

  it('does not merge a deliberate re-articulation', () => {
    const repeated: NoteEvent[] = [
      { startSec: 0.0, endSec: 0.4, pitch: 57, velocity: 90 },
      // A clear gap: the singer stopped and started again.
      { startSec: 0.9, endSec: 1.3, pitch: 57, velocity: 90 },
    ];
    expect(mergeFragments(repeated, features)).toHaveLength(2);
  });

  it('does not merge different pitches', () => {
    const different: NoteEvent[] = [
      { startSec: 0, endSec: 0.2, pitch: 57, velocity: 90 },
      { startSec: 0.21, endSec: 0.4, pitch: 59, velocity: 90 },
    ];
    expect(mergeFragments(different, features)).toHaveLength(2);
  });

  it('never lets a note overlap the next one', () => {
    const overlapping: NoteEvent[] = [
      { startSec: 0, endSec: 2.5, pitch: 57, velocity: 90 },
      { startSec: 0.58, endSec: 1.08, pitch: 59, velocity: 90 },
    ];
    const repaired = reconstructDurations(overlapping, features);
    const first = repaired[0] as NoteEvent;
    const second = repaired[1] as NoteEvent;
    expect(first.endSec).toBeLessThanOrEqual(second.startSec + 1e-9);
  });

  it('keeps every repaired note inside the clip', () => {
    const repaired = reconstructDurations(correctNotes(), features);
    for (const note of repaired) {
      expect(note.endSec).toBeLessThanOrEqual(features.durationSec + 1e-6);
      expect(note.endSec).toBeGreaterThan(note.startSec);
    }
  });
});

describe('judge and repair', () => {
  it('leaves an already-correct transcription alone', () => {
    const result = judgeAndRepair(correctNotes(), features);
    expect(result.judgedNotes.map((n) => n.pitch)).toEqual(correctNotes().map((n) => n.pitch));
    expect(result.improvement).toBe(0);
  });

  it('repairs the reported failure: octave error plus harmonic artifact', () => {
    // The shape of the bug in the brief: A2 where A3 was sung, plus a note at
    // a harmonic that was never a fundamental.
    const broken: NoteEvent[] = [
      { startSec: 0.0, endSec: 0.5, pitch: 45, velocity: 90 }, // A2, should be A3
      { startSec: 0.0, endSec: 0.3, pitch: 69, velocity: 60 }, // harmonic ghost
      { startSec: 0.58, endSec: 1.08, pitch: 59, velocity: 90 },
      { startSec: 1.16, endSec: 1.66, pitch: 60, velocity: 90 },
      { startSec: 1.74, endSec: 2.24, pitch: 62, velocity: 90 },
      { startSec: 2.32, endSec: 2.82, pitch: 64, velocity: 90 },
    ];

    const result = judgeAndRepair(broken, features);

    expect(result.improvement).toBeGreaterThan(0);
    expect(result.judgedScore.overall).toBeGreaterThan(result.originalScore.overall);
    // The octave slip is corrected rather than deleted.
    expect(result.judgedNotes.some((note) => note.pitch === 57)).toBe(true);
    expect(result.judgedNotes.some((note) => note.pitch === 45)).toBe(false);
    expect(result.judgedScore.diagnostics.unsupportedNotes).toBeLessThan(
      result.originalScore.diagnostics.unsupportedNotes,
    );
  });

  it('repairs fragmentation into whole notes', () => {
    const fragmented: NoteEvent[] = [
      { startSec: 0.0, endSec: 0.12, pitch: 57, velocity: 85 },
      { startSec: 0.15, endSec: 0.29, pitch: 57, velocity: 90 },
      { startSec: 0.32, endSec: 0.5, pitch: 57, velocity: 88 },
      { startSec: 0.58, endSec: 1.08, pitch: 59, velocity: 90 },
    ];
    const result = judgeAndRepair(fragmented, features);
    expect(result.judgedNotes.length).toBeLessThan(fragmented.length);
    expect(result.judgedScore.fragmentation).toBeGreaterThanOrEqual(
      result.originalScore.fragmentation,
    );
  });

  it('never returns a worse result than it was given', () => {
    const cases: NoteEvent[][] = [
      correctNotes(),
      [{ startSec: 0, endSec: 0.5, pitch: 57, velocity: 90 }],
      [{ startSec: 0, endSec: 0.05, pitch: 99, velocity: 20 }],
    ];
    for (const candidate of cases) {
      const result = judgeAndRepair(candidate, features);
      expect(result.judgedScore.overall).toBeGreaterThanOrEqual(result.originalScore.overall);
      expect(result.improvement).toBeGreaterThanOrEqual(0);
    }
  });

  it('always preserves the original, untouched', () => {
    const input = correctNotes();
    const snapshot = JSON.stringify(input);
    const result = judgeAndRepair(input, features);
    // The caller's array is not mutated, and the original is returned as-is.
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(result.originalNotes.map((n) => n.pitch)).toEqual(input.map((n) => n.pitch));
  });

  it('reports what it did, in order', () => {
    const broken: NoteEvent[] = [
      { startSec: 0.0, endSec: 0.5, pitch: 45, velocity: 90 },
      { startSec: 0.0, endSec: 0.3, pitch: 69, velocity: 60 },
      { startSec: 0.58, endSec: 1.08, pitch: 59, velocity: 90 },
      { startSec: 1.16, endSec: 1.66, pitch: 60, velocity: 90 },
    ];
    const result = judgeAndRepair(broken, features);
    expect(result.repairs.length).toBeGreaterThan(0);
    for (const step of result.repairs) {
      expect(step.description.length).toBeGreaterThan(0);
      expect(step.scoreAfter).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic across runs', () => {
    const broken: NoteEvent[] = [
      { startSec: 0.0, endSec: 0.5, pitch: 45, velocity: 90 },
      { startSec: 0.0, endSec: 0.3, pitch: 69, velocity: 60 },
      { startSec: 0.58, endSec: 1.08, pitch: 59, velocity: 90 },
    ];
    const a = judgeAndRepair(broken, features);
    const b = judgeAndRepair(broken, features);
    expect(a.judgedNotes).toEqual(b.judgedNotes);
    expect(a.repairs.map((r) => r.operator)).toEqual(b.repairs.map((r) => r.operator));
  });

  it('handles an empty candidate without throwing', () => {
    const result = judgeAndRepair([], features);
    expect(result.judgedNotes).toEqual([]);
    expect(result.repairs).toEqual([]);
  });
});

describe('banded DTW', () => {
  it('is zero for identical sequences', () => {
    expect(bandedDtw([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('grows with disagreement', () => {
    expect(bandedDtw([0, 0, 0], [5, 5, 5])).toBeGreaterThan(bandedDtw([0, 0, 0], [1, 1, 1]));
  });

  it('tolerates a stretched but identically shaped sequence', () => {
    // The property that makes it useful for shape rather than for timing.
    const straight = bandedDtw([0, 2, 4, 2, 0], [0, 2, 4, 2, 0]);
    const stretched = bandedDtw([0, 2, 4, 2, 0], [0, 2, 2, 4, 2, 0]);
    expect(stretched).toBeLessThan(straight + 3);
  });
});
