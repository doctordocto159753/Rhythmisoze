/**
 * The single-octave-authority guard.
 *
 * The failure this pins down: YIN can track a confident subharmonic, the
 * extraction stage then chooses a register from those frames plus phrase
 * context, and the Judge — seeing only local frames — "corrects" the register
 * back. Two authorities, one piece of evidence, and a phrase that will not sit
 * in the same octave between builds.
 *
 * The rule under test: a Judge whose candidate carries measured provenance
 * defers — it moves nothing and reports the disagreement. A Judge facing a
 * foreign candidate (tests, future routes) may only fold when the frames under
 * the note decisively explain the target register.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import { midiToFrequency, type PitchFrame } from '@/packages/melody-extraction';
import {
  correctOctaves,
  detectOctaveConflicts,
  judgeAndRepair,
  judgeFeaturesFromFrames,
  type JudgeFeatures,
} from '@musical-judge';

const HOP = 0.01;

function frameAt(index: number, midiPitch: number | null, clarity = 0.9): PitchFrame {
  const candidate = midiPitch;
  return {
    timeSec: Number((index * HOP).toFixed(4)),
    frequencyHz: midiPitch === null ? null : midiToFrequency(midiPitch),
    midiPitch,
    candidateHz: candidate === null ? null : midiToFrequency(candidate),
    candidateMidi: candidate,
    clarity,
    confidence: clarity,
    rms: midiPitch === null ? 0.01 : 0.2,
    voiced: midiPitch !== null,
    origin: 'measured' as const,
  };
}

/** A contour of accepted pitches, one frame each, at 10 ms hop. */
function contour(pitches: ReadonlyArray<number | null>): JudgeFeatures {
  return judgeFeaturesFromFrames(
    pitches.map((pitch, index) => frameAt(index, pitch)),
    pitches.length * HOP,
    [],
  );
}

function note(startSec: number, endSec: number, pitch: number): NoteEvent {
  return { startSec, endSec, pitch, velocity: 90, confidence: 0.9 };
}

describe('correctOctaves evidence gate (foreign candidates)', () => {
  it('folds the allowed case: one noisy frame against a decisive register', () => {
    // Frames say 60 almost everywhere; the note claims 48 on the strength of
    // one noisy reading. This fold is what octave repair is for.
    const features = contour([60, 60, 59, 61, 48]);
    const notes = [note(0, 0.05, 48)];
    const repaired = correctOctaves(notes, features);
    expect(repaired[0]?.pitch).toBe(60);
  });

  it('refuses the mirror mistake: moving notes away from the audio', () => {
    // Frames unanimously read 52; nothing licenses moving anything to 64.
    const features = contour([52, 52, 53, 52]);
    const notes = [note(0, 0.04, 52)];
    expect(correctOctaves(notes, features)[0]?.pitch).toBe(52);
  });

  it('refuses a fold the frames only half support', () => {
    // The span reads 52 for one half and 64 for the other: a fold would be a
    // guess, whichever direction it points.
    const half = 25;
    const pitches: Array<number | null> = [
      ...Array<number | null>(half).fill(52),
      ...Array<number | null>(half).fill(64),
    ];
    const features = contour(pitches);
    const spanSec = pitches.length * HOP;
    expect(correctOctaves([note(0, spanSec, 64)], features)[0]?.pitch).toBe(64);
    expect(correctOctaves([note(0, spanSec, 52)], features)[0]?.pitch).toBe(52);
  });

  it('leaves a note alone when its own register is the supported one', () => {
    const features = contour([64, 63.6, 64.2, 63.8]);
    const notes = [note(0, 0.04, 64)];
    expect(correctOctaves(notes, features)[0]?.pitch).toBe(64);
  });
});

describe('respectCandidateRegister (pipeline candidates)', () => {
  it('defers to the transcription register even against unanimous frames', () => {
    // The pipeline produced E4 (64) from phrase context while the local frames
    // confidently read the subharmonic. The old median-distance rule folded
    // this; the authority gate refuses, because re-deciding the extractor's
    // register from a subset of its information is how phrases flip octaves
    // between stages.
    const features = contour(Array<number | null>(30).fill(52.2));
    const notes = [note(0, 0.3, 64)];
    expect(correctOctaves(notes, features, { respectCandidateRegister: true })).toEqual(notes);
  });

  it('reports the deferred disagreement with its support numbers', () => {
    const features = contour([...Array<number | null>(20).fill(52.2), ...Array<number | null>(10).fill(52.4)]);
    const notes = [note(0, 0.3, 64)];
    const conflicts = detectOctaveConflicts(notes, features);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.notePitch).toBe(64);
    expect(conflicts[0]?.referenceMedian).toBeCloseTo(52.2, 0);
    expect(conflicts[0]?.referenceSupport).toBeGreaterThan(0.9);
    expect(conflicts[0]?.noteSupport).toBeLessThan(0.1);
  });

  it('stays silent when the frames have no clear opinion', () => {
    // Too few frames to speak for the reference: not a conflict, just grit.
    const features = contour([52, 52, 52]);
    const notes = [note(0, 0.03, 64)];
    expect(detectOctaveConflicts(notes, features)).toHaveLength(0);
  });

  it('stays silent when the registers agree', () => {
    const features = contour(Array<number | null>(12).fill(64));
    const notes = [note(0, 0.12, 64)];
    expect(detectOctaveConflicts(notes, features)).toHaveLength(0);
  });

  it('judgeAndRepair keeps the measured register and surfaces the conflict', () => {
    // End to end, exactly as the worker calls it: a sung phrase whose middle
    // note sits an octave above its local frames. The verdict must preserve
    // the pipeline's register and attach the conflict rather than fold.
    const frames: PitchFrame[] = [];
    for (let index = 0; index < 100; index += 1) {
      const time = index * HOP;
      if (time >= 0.3 && time < 0.6) frames.push(frameAt(index, 52.3));
      else frames.push(frameAt(index, time < 0.3 ? 59.8 : 62.1));
    }
    const features = judgeFeaturesFromFrames(frames, 1, []);
    const candidate = [
      note(0.05, 0.29, 60),
      note(0.31, 0.59, 64),
      note(0.61, 0.95, 62),
    ];
    const verdict = judgeAndRepair(candidate, features, {
      repair: { respectCandidateRegister: true },
    });
    expect(verdict.judgedNotes.map((n) => n.pitch)).toEqual([60, 64, 62]);
    expect(verdict.octaveConflicts.length).toBeGreaterThan(0);
    expect(verdict.octaveConflicts.some((c) => c.notePitch === 64)).toBe(true);
  });

  it('judgeAndRepair without the flag still corrects foreign candidates', () => {
    // Regression guard for the standalone path: a hand-built candidate whose
    // note genuinely contradicts decisive frames gets repaired as before.
    const features = contour([
      ...Array<number | null>(40).fill(60),
      ...Array<number | null>(40).fill(60),
    ]);
    const candidate = [note(0.05, 0.75, 72)];
    const verdict = judgeAndRepair(candidate, features);
    expect(verdict.judgedNotes[0]?.pitch).toBe(60);
    expect(verdict.octaveConflicts).toEqual([]);
  });
});
