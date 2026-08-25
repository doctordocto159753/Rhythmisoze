/**
 * The bounded voicing grace: decaying-tail hold.
 *
 * Exists because real humming breaks the old binary in one specific way: notes
 * fade below the sustain ratio while the pitch is still locked, so ending the
 * region at the threshold cut every tail early. The hold is bounded, and each
 * test walks its bound as well as its happy path — an unbounded grace is not a
 * grace, it is a new way to be wrong.
 *
 * The octave case is deliberately absent as a *grace* and present as a
 * *refusal*: a forensic pass on a quiet articulated take showed that letting a
 * held region survive octave-displaced stretches lets downstream segment-octave
 * repair flip whole phrases into the subharmonic register. A subharmonic dip
 * must end the region exactly as it did before; the bridging stage handles
 * quiet passages instead, where endpoint evidence — not the dip itself —
 * decides.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PITCH_TRACKER_OPTIONS,
  decideVoicing,
  type FrameEvidence,
} from '@/packages/melody-extraction';

const GATE = 0.02;
const HOP = 0.01;

function evidenceAt(
  timeSec: number,
  candidateMidi: number | null,
  options: { clarity?: number; rms?: number } = {},
): FrameEvidence {
  const midi = candidateMidi;
  return {
    timeSec,
    candidateHz: midi === null ? null : 440 * 2 ** ((midi - 69) / 12),
    candidateMidi: midi,
    clarity: options.clarity ?? 0.7,
    rms: options.rms ?? 0.04,
    confidence: options.clarity ?? 0.7,
  };
}

function runsOf(voiced: readonly boolean[]): number[][] {
  const runs: number[][] = [];
  let current: number[] | null = null;
  voiced.forEach((isVoiced, index) => {
    if (isVoiced) {
      if (!current) current = [];
      current.push(index);
    } else if (current) {
      runs.push(current);
      current = null;
    }
  });
  if (current) runs.push(current);
  return runs;
}

describe('decaying-tail hold', () => {
  it('rides a natural fade without cutting the note early', () => {
    const decay = Array.from({ length: 14 }, (_, i) =>
      evidenceAt(0.05 + i * HOP, 60, {
        clarity: 0.6,
        // Below the sustain ratio (gate * 0.62), above the grace floor.
        rms: 0.012,
      }),
    );
    const evidence: FrameEvidence[] = [
      evidenceAt(0, 60, { clarity: 0.85, rms: 0.05 }),
      ...Array.from({ length: 4 }, (_, i) => evidenceAt(0.01 + i * HOP, 60)),
      ...decay,
    ];
    const frames = decideVoicing(evidence, GATE);

    expect(runsOf(frames.map((frame) => frame.voiced)).length).toBe(1);
    expect(frames.at(-1)?.voiced).toBe(true);
  });

  it('stops holding once the bound is reached', () => {
    const tail = DEFAULT_PITCH_TRACKER_OPTIONS.tailHoldFrames;
    const decay = Array.from({ length: tail + 4 }, (_, i) =>
      evidenceAt(0.05 + i * HOP, 60, { clarity: 0.6, rms: 0.011 }),
    );
    const evidence: FrameEvidence[] = [
      evidenceAt(0, 60, { clarity: 0.85, rms: 0.05 }),
      ...Array.from({ length: 4 }, (_, i) => evidenceAt(0.01 + i * HOP, 60)),
      ...decay,
    ];
    const frames = decideVoicing(evidence, GATE);
    const runs = runsOf(frames.map((frame) => frame.voiced));

    expect(runs.length).toBe(1);
    expect(runs[0]?.length).toBe(5 + tail);
  });

  it('ends immediately when the level sinks into the floor', () => {
    const evidence: FrameEvidence[] = [
      evidenceAt(0, 60, { clarity: 0.85, rms: 0.05 }),
      ...Array.from({ length: 4 }, (_, i) => evidenceAt(0.01 + i * HOP, 60)),
      // A true rest: no energy worth the name.
      evidenceAt(0.06, 60, { clarity: 0.6, rms: 0.002 }),
    ];
    const frames = decideVoicing(evidence, GATE);

    expect(frames[5]?.voiced).toBe(false);
  });

  it('never bridges across silence even with agreeing candidates', () => {
    const evidence: FrameEvidence[] = [
      evidenceAt(0, 60, { clarity: 0.85, rms: 0.05 }),
      ...Array.from({ length: 4 }, (_, i) => evidenceAt(0.01 + i * HOP, 60)),
      evidenceAt(0.06, 60, { clarity: 0.6, rms: 0.002 }),
      // The pitch comes back strongly: that is a new note, not a longer one.
      evidenceAt(0.07, 60, { clarity: 0.85, rms: 0.05 }),
      ...Array.from({ length: 3 }, (_, i) => evidenceAt(0.08 + i * HOP, 60)),
    ];
    const frames = decideVoicing(evidence, GATE);
    const runs = runsOf(frames.map((frame) => frame.voiced));

    expect(runs.length).toBe(2);
  });

  it('ends the region on an octave-displaced stretch instead of holding it', () => {
    // Regression guard for a measured failure: when weak frames read a
    // subharmonic of the held note, the region must end. Holding it open let
    // segment-level octave repair flip an entire phrase register on a real
    // quiet take (TARGET TEST 3, opening phrase: C4 material landed as C3).
    const evidence: FrameEvidence[] = [
      evidenceAt(0, 60, { clarity: 0.85, rms: 0.05 }),
      ...Array.from({ length: 8 }, (_, i) => evidenceAt(0.01 + i * HOP, 60)),
      // Fourteen frames where YIN reads the note an octave down: sustained
      // enough to dominate any stretch it survives into.
      ...Array.from({ length: 14 }, (_, i) =>
        evidenceAt(0.09 + i * HOP, 48, { clarity: 0.55, rms: 0.03 }),
      ),
      ...Array.from({ length: 8 }, (_, i) => evidenceAt(0.23 + i * HOP, 60)),
    ];
    const frames = decideVoicing(evidence, GATE);

    // The fold must not be voiced through; at most the pre-dip region stands.
    const dipStart = 9;
    for (let index = dipStart; index < dipStart + 14; index += 1) {
      expect(frames[index]?.voiced, `frame ${index}`).toBe(false);
    }
  });

  it('still opens a new region for a strong real leap', () => {
    const evidence: FrameEvidence[] = [
      evidenceAt(0, 60, { clarity: 0.85, rms: 0.05 }),
      ...Array.from({ length: 4 }, (_, i) => evidenceAt(0.01 + i * HOP, 60)),
      // An octave up, sung at full strength: a new note, and it says so.
      evidenceAt(0.06, 72, { clarity: 0.8, rms: 0.05 }),
      ...Array.from({ length: 3 }, (_, i) => evidenceAt(0.07 + i * HOP, 72)),
    ];
    const frames = decideVoicing(evidence, GATE);

    expect(frames.map((frame) => frame.voiced).every(Boolean)).toBe(true);
  });
});
