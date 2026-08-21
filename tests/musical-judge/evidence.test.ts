/**
 * What the Judge is allowed to see, and what it is allowed to do with it.
 *
 * The Judge answers one question — *did we understand the human?* — against a
 * per-frame measurement of the audio. It used to re-filter that measurement at
 * `confidence >= 0.5`, on top of the tracker's own gate, which made it blind in
 * exactly the places the tracker was blind: the quiet tail of a held note,
 * where the pitch is perfectly stable and the level is not. A note trimmed
 * there is trimmed twice for the same wrong reason.
 *
 * The tracker's decision is now hysteretic and continuity-checked, so an
 * accepted frame is corroborated by its neighbours rather than by its own
 * score, and the Judge takes it as read. What it re-reads instead are the
 * frames the tracker *rejected*, to ask whether a note should reach through
 * them — using measurements that were taken and not accepted, never a guess.
 *
 * The line these tests hold: more evidence, not more licence. The Judge may
 * extend a note through a patch where the audio still says that pitch. It may
 * not invent a pitch where the audio says nothing.
 */

import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import { midiToFrequency, type PitchFrame } from '@/packages/melody-extraction';
import {
  judgeFeaturesFromFrames,
  provisionalPitchAt,
  provisionalPitchesDuring,
  referencePitchesDuring,
  voicedEndAfter,
  type JudgeFeatures,
} from '@/packages/musical-judge';
import { reconstructDurations } from '@/packages/musical-judge/repair';

const A4 = 69;
const HOP = 0.01;

type FrameSpec = {
  /** Accepted pitch, or null where the tracker declined the frame. */
  accepted?: number | null;
  /** What YIN measured, whatever the decision. */
  candidate?: number | null;
  clarity?: number;
  rms?: number;
};

function frames(specs: readonly FrameSpec[]): PitchFrame[] {
  return specs.map((spec, index) => {
    const accepted = spec.accepted ?? null;
    const candidate = spec.candidate === undefined ? accepted : spec.candidate;
    const clarity = spec.clarity ?? (accepted !== null ? 0.85 : 0.1);
    return {
      timeSec: Number((index * HOP).toFixed(4)),
      frequencyHz: accepted === null ? null : midiToFrequency(accepted),
      midiPitch: accepted,
      candidateHz: candidate === null ? null : midiToFrequency(candidate),
      candidateMidi: candidate,
      clarity,
      confidence: clarity,
      rms: spec.rms ?? (accepted !== null ? 0.2 : 0.01),
      voiced: accepted !== null,
    };
  });
}

function featuresFor(specs: readonly FrameSpec[]): JudgeFeatures {
  const built = frames(specs);
  return judgeFeaturesFromFrames(built, built.length * HOP, []);
}

/** Held A4, a 120 ms patch the tracker declined but which still reads A4, then A4 again. */
const heldWithUncertainPatch: FrameSpec[] = [
  ...Array.from({ length: 40 }, () => ({ accepted: A4 })),
  ...Array.from({ length: 12 }, () => ({ accepted: null, candidate: A4 + 0.1, clarity: 0.45 })),
  ...Array.from({ length: 40 }, () => ({ accepted: A4 })),
  ...Array.from({ length: 20 }, () => ({ accepted: null, candidate: null, clarity: 0.05 })),
];

/** Held A4, then genuine silence: nothing measured, nothing to hold on to. */
const heldThenSilence: FrameSpec[] = [
  ...Array.from({ length: 40 }, () => ({ accepted: A4 })),
  ...Array.from({ length: 60 }, () => ({ accepted: null, candidate: null, clarity: 0.03 })),
];

describe('the accepted contour', () => {
  it('is taken as read rather than re-thresholded on loudness', () => {
    // A held note whose level has decayed: stable pitch, weak energy. The
    // tracker accepted these frames on continuity evidence, and the Judge must
    // not throw them away again for being quiet.
    const decaying = frames(
      Array.from({ length: 30 }, () => ({ accepted: A4, clarity: 0.4, rms: 0.012 })),
    );
    const features = judgeFeaturesFromFrames(decaying, 0.3, []);
    expect(features.voicedFrames).toBe(30);
    expect(referencePitchesDuring(features, 0, 0.3)).toHaveLength(30);
  });
});

describe('provisional evidence', () => {
  const features = featuresFor(heldWithUncertainPatch);

  it('reports what was measured inside a patch the tracker declined', () => {
    const insidePatch = provisionalPitchAt(features, 0.45);
    expect(insidePatch).not.toBeNull();
    expect(Math.abs((insidePatch as number) - A4)).toBeLessThan(0.5);
    // And the accepted reference says nothing there, which is the distinction.
    expect(referencePitchesDuring(features, 0.41, 0.51)).toHaveLength(0);
  });

  it('reports nothing where nothing was measured', () => {
    // The whole guard against hallucination: no candidate means no answer, not
    // an interpolation across the hole.
    expect(provisionalPitchAt(featuresFor(heldThenSilence), 0.8)).toBeNull();
    expect(provisionalPitchesDuring(featuresFor(heldThenSilence), 0.5, 1.0)).toEqual([]);
  });

  it('will not offer a candidate too unclear to mean anything', () => {
    const noisy = featuresFor([
      ...Array.from({ length: 10 }, () => ({ accepted: A4 })),
      // A candidate exists, but YIN had no confidence in the periodicity.
      ...Array.from({ length: 20 }, () => ({ accepted: null, candidate: 44, clarity: 0.12 })),
    ]);
    expect(provisionalPitchAt(noisy, 0.2)).toBeNull();
  });
});

describe('where a note ends', () => {
  it('reaches through an uncertain patch that still reads as the same pitch', () => {
    const features = featuresFor(heldWithUncertainPatch);
    const end = voicedEndAfter(features, 0, A4);
    expect(end).not.toBeNull();
    // The note runs to the end of the second block at 0.92 s, not to 0.40 s
    // where the tracker first declined a frame.
    expect(end as number).toBeGreaterThan(0.85);
  });

  it('stops at real silence', () => {
    const end = voicedEndAfter(featuresFor(heldThenSilence), 0, A4);
    expect(end).not.toBeNull();
    expect(end as number).toBeLessThan(0.55);
  });

  it('does not reach through evidence for a different pitch', () => {
    // Evidence that some pitch is present is not evidence that *this* pitch is.
    // Without the hint a note would grow across its neighbour.
    const features = featuresFor([
      ...Array.from({ length: 30 }, () => ({ accepted: A4 })),
      ...Array.from({ length: 10 }, () => ({ accepted: null, candidate: A4 - 7, clarity: 0.6 })),
      ...Array.from({ length: 30 }, () => ({ accepted: A4 - 7 })),
    ]);
    const end = voicedEndAfter(features, 0, A4);
    expect(end).not.toBeNull();
    expect(end as number).toBeLessThan(0.42);
  });
});

describe('duration repair', () => {
  it('extends a note the segmenter cut short, up to the evidence', () => {
    const features = featuresFor(heldWithUncertainPatch);
    const cutShort: NoteEvent[] = [{ startSec: 0, endSec: 0.4, pitch: A4, velocity: 90 }];
    const repaired = reconstructDurations(cutShort, features);
    expect((repaired[0] as NoteEvent).endSec).toBeGreaterThan(0.85);
  });

  it('does not extend a note into silence', () => {
    const features = featuresFor(heldThenSilence);
    const overlong: NoteEvent[] = [{ startSec: 0, endSec: 0.95, pitch: A4, velocity: 90 }];
    const repaired = reconstructDurations(overlong, features);
    expect((repaired[0] as NoteEvent).endSec).toBeLessThan(0.6);
  });

  it('invents no pitch it was not given', () => {
    // Duration repair moves ends. It has no route to a pitch, and this is the
    // assertion that says so rather than a comment claiming it.
    const features = featuresFor(heldWithUncertainPatch);
    const notes: NoteEvent[] = [
      { startSec: 0, endSec: 0.4, pitch: A4, velocity: 90 },
      { startSec: 0.95, endSec: 1.05, pitch: A4 - 3, velocity: 80 },
    ];
    const repaired = reconstructDurations(notes, features);
    expect(repaired.map((note) => note.pitch)).toEqual([A4, A4 - 3]);
    expect(repaired).toHaveLength(2);
  });
});
