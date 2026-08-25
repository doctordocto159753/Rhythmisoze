/**
 * Evidence-aware bridging: provenance authority rules.
 *
 * The withdrawn octave-fold bridging failed because inferred frames acquired
 * three kinds of authority: they glued segments together across articulation
 * boundaries, they diluted segment confidence (re-weighting phrase-level
 * octave repair), and they entered the running median that anchors sequential
 * octave repair. Each test here pins one of those pathways shut.
 *
 * The full-chain tests at the end are the Test 3 opening-phrase guard: a
 * staccato repeated tone with weak subharmonic readings between notes must
 * stay separate notes in the sung register, while a sustained tone with a
 * genuine tracking dropout must come out as one note — also in the sung
 * register, whatever the dropout's candidates said.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateMelodyConfidence,
  decideVoicing,
  generateMelodyNoteEvents,
  segmentPitchContour,
  smoothPitchContour,
  type FrameEvidence,
  type PitchFrame,
} from '@/packages/melody-extraction';
import { judgeFeaturesFromFrames } from '@musical-judge';

function frameAt(
  timeSec: number,
  midiPitch: number | null,
  options: {
    confidence?: number;
    clarity?: number;
    rms?: number;
    candidateMidi?: number | null;
    origin?: PitchFrame['origin'];
  } = {},
): PitchFrame {
  const confidence = options.confidence ?? 0.9;
  const clarity = options.clarity ?? confidence;
  const candidate = options.candidateMidi === undefined ? midiPitch : options.candidateMidi;
  return {
    timeSec,
    frequencyHz: midiPitch === null ? null : 440 * 2 ** ((midiPitch - 69) / 12),
    midiPitch,
    candidateHz: candidate === null ? null : 440 * 2 ** ((candidate - 69) / 12),
    candidateMidi: candidate,
    clarity,
    confidence,
    rms: options.rms ?? 0.05,
    voiced: midiPitch !== null,
    origin: options.origin ?? 'measured',
  };
}

describe('bridged frames carry interpolation provenance and no authority', () => {
  it('joins two same-pitch regions across a filled hole into one segment', () => {
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 10; i += 1) frames.push(frameAt(i * 0.01, 67));
    for (let i = 10; i < 22; i += 1) {
      frames.push(frameAt(i * 0.01, null, { candidateMidi: 55, clarity: 0.7 }));
    }
    for (let i = 22; i < 32; i += 1) frames.push(frameAt(i * 0.01, 67));

    const smoothed = smoothPitchContour(frames);
    const segments = segmentPitchContour(smoothed.frames, { minDurationSec: 0.12 });

    expect(segments.length).toBe(1);
    expect(segments[0]?.startSec).toBeCloseTo(0, 5);
    expect(segments[0]?.endSec).toBeGreaterThan(0.3);
    // The note is what was measured, not what the hole's candidates said.
    expect(Math.abs((segments[0]?.midiPitch as number) - 67)).toBeLessThan(0.5);
  });

  it('excludes interpolated frames from the segment confidence average', () => {
    const measuredOnly: PitchFrame[] = [];
    for (let i = 0; i < 20; i += 1) measuredOnly.push(frameAt(i * 0.01, 60));
    const withBridged: PitchFrame[] = [];
    for (let i = 0; i < 8; i += 1) withBridged.push(frameAt(i * 0.01, 60));
    for (let i = 8; i < 14; i += 1) {
      withBridged.push(frameAt(i * 0.01, 60, { origin: 'interpolated', confidence: 0.1 }));
    }
    for (let i = 14; i < 26; i += 1) withBridged.push(frameAt(i * 0.01, 60));

    const plain = segmentPitchContour(measuredOnly, { minDurationSec: 0.12 });
    const bridged = segmentPitchContour(withBridged, { minDurationSec: 0.12 });

    expect(bridged.length).toBe(1);
    expect(plain.length).toBe(1);
    // Six low-confidence inference frames would drag the average from ~0.9 to
    // ~0.66 if they scored. They do not score.
    expect(bridged[0]?.confidence).toBeGreaterThan(0.85);
  });

  it('lets interpolated values vote on nothing: a wrong-register fill cannot move the settled pitch', () => {
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 10; i += 1) frames.push(frameAt(i * 0.01, 57));
    // A degraded producer wrote interpolated frames at the subharmonic. The
    // bridge would never do this, but the authority rule must hold regardless
    // of who wrote the frame: measurement outvotes inference by construction.
    for (let i = 10; i < 16; i += 1) {
      frames.push(frameAt(i * 0.01, 45, { origin: 'interpolated', confidence: 0.9 }));
    }
    for (let i = 16; i < 28; i += 1) frames.push(frameAt(i * 0.01, 57));

    const segments = segmentPitchContour(frames, { minDurationSec: 0.12 });

    expect(segments.length).toBe(1);
    expect(Math.abs((segments[0]?.midiPitch as number) - 57)).toBeLessThan(0.5);
  });

  it('keeps sequential octave repair anchored on measurement only', () => {
    // Four measured 60s then five interpolated 84s: if inference entered the
    // running median, the anchor would drift up and a following measured 71
    // (an octave-family slip against a 60 anchor) would fold upward toward
    // ~83 instead of down to its sung register. With inference excluded the
    // anchor stays at 60 and the repair happens as it should.
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 4; i += 1) frames.push(frameAt(i * 0.02, 60));
    for (let i = 4; i < 9; i += 1) {
      frames.push(frameAt(i * 0.02, 84, { origin: 'interpolated' }));
    }
    for (let i = 9; i < 11; i += 1) frames.push(frameAt(i * 0.02, 71));

    const smoothed = smoothPitchContour(frames);
    const repaired = smoothed.frames.filter(
      (frame) => frame.origin !== 'interpolated' && frame.midiPitch !== null,
    );

    expect(repaired.length).toBeGreaterThanOrEqual(6);
    const finalPitch = repaired.at(-1)?.midiPitch as number;
    // Folded down toward the measured register, never up toward the poison.
    expect(finalPitch).toBeGreaterThan(57);
    expect(finalPitch).toBeLessThan(63);
    // And the interpolated values themselves were never folded anywhere.
    expect(
      smoothed.frames
        .filter((frame) => frame.origin === 'interpolated')
        .every(
          (frame) => frame.midiPitch === null || Math.abs(frame.midiPitch - 84) < 0.001,
        ),
    ).toBe(true);
  });

  it('reports quality from measurement alone', () => {
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 50; i += 1) frames.push(frameAt(i * 0.01, 60));
    for (let i = 50; i < 100; i += 1) {
      frames.push(frameAt(i * 0.01, 60, { origin: 'interpolated', confidence: 0.4 }));
    }

    const assessment = calculateMelodyConfidence(frames, [], null);

    // Half the frames are inference; coverage describes only the half that
    // was heard.
    expect(assessment.voicedFramePercentage).toBeCloseTo(0.5, 5);
  });

  it('withdraws accepted-pitch authority before the Judge sees it', () => {
    const frames: PitchFrame[] = [
      frameAt(0.0, 60),
      frameAt(0.01, 60, { origin: 'interpolated', confidence: 0.2 }),
      frameAt(0.02, 60),
    ];
    const features = judgeFeaturesFromFrames(frames, 0.03, []);

    expect(features.frames[1]?.midiPitch).toBe(null);
    // The measured candidate survives: duration evidence still works through
    // the honest path.
    expect(features.frames[1]?.candidateMidi).toBe(60);
    expect(features.voicedFrames).toBe(2);
  });
});

describe('full-chain register guards', () => {
  const GATE = 0.02;

  function evidenceAt(timeSec: number, candidateMidi: number | null, clarity: number, rms: number): FrameEvidence {
    return {
      timeSec,
      candidateHz: candidateMidi === null ? null : 440 * 2 ** ((candidateMidi - 69) / 12),
      candidateMidi,
      clarity,
      rms,
      confidence: clarity,
    };
  }

  function chain(evidence: readonly FrameEvidence[]) {
    const tracked = decideVoicing([...evidence], GATE);
    const smoothed = smoothPitchContour(tracked);
    const segments = segmentPitchContour(smoothed.frames, {
      minDurationSec: 0.12,
      register: smoothed.range
        ? { lowMidi: smoothed.range.lowMidi, highMidi: smoothed.range.highMidi }
        : null,
    });
    return { segments, notes: generateMelodyNoteEvents(segments), smoothed };
  }

  it('staccato repeated C4s with silent articulations stay separate C4 notes', () => {
    // The TARGET TEST 3 opening analog: strong 60-readings per note, weak
    // subharmonic readings during the articulation, digital silence inside it,
    // and an articulation long enough that nothing downstream may legally
    // merge same-pitch neighbours across it.
    const evidence: FrameEvidence[] = [];
    let time = 0;
    for (let note = 0; note < 4; note += 1) {
      for (let i = 0; i < 18; i += 1) {
        evidence.push(evidenceAt(time, 60 + 0.05 * Math.sin(i), 0.85, 0.05));
        time += 0.01;
      }
      // Articulation: energy collapses to digital silence while weak
      // subharmonic candidates flicker either side of it. Ten frames — past
      // the segmentation gap backstop and past same-pitch consolidation.
      evidence.push(evidenceAt(time, 48.2, 0.55, 0.02));
      time += 0.01;
      for (let i = 0; i < 8; i += 1) {
        evidence.push(evidenceAt(time, i % 2 ? 47.8 : 48.1, 0.5, 0.0002));
        time += 0.01;
      }
      evidence.push(evidenceAt(time, 48.1, 0.54, 0.02));
      time += 0.01;
    }

    const { notes } = chain(evidence);

    expect(notes.length).toBe(4);
    for (const note of notes) {
      expect(Math.abs(note.pitch - 60)).toBeLessThan(1);
    }
  });

  it('a sustained tone with a continuous-energy dropout comes back as one C4 note', () => {
    // Same subharmonic readings, but the tone never stops sounding: this is
    // the case the bridge exists for, and the register it reports is the one
    // the endpoints measured.
    const evidence: FrameEvidence[] = [];
    let time = 0;
    for (let i = 0; i < 30; i += 1) {
      evidence.push(evidenceAt(time, 60, 0.88, 0.05));
      time += 0.01;
    }
    for (let i = 0; i < 12; i += 1) {
      evidence.push(evidenceAt(time, 48.1, 0.62, 0.04));
      time += 0.01;
    }
    for (let i = 0; i < 30; i += 1) {
      evidence.push(evidenceAt(time, 60, 0.88, 0.05));
      time += 0.01;
    }

    const { notes } = chain(evidence);

    expect(notes.length).toBe(1);
    expect(notes[0]?.startSec).toBeLessThan(0.02);
    expect(notes[0]?.endSec).toBeGreaterThan(0.7);
    expect(Math.abs(notes[0]?.pitch as number)).toBeLessThanOrEqual(61);
    expect(Math.abs(notes[0]?.pitch as number)).toBeGreaterThanOrEqual(59);
  });

  it('a true rest between phrases stays a rest end to end', () => {
    const evidence: FrameEvidence[] = [];
    let time = 0;
    for (let i = 0; i < 40; i += 1) {
      evidence.push(evidenceAt(time, 60, 0.88, 0.05));
      time += 0.01;
    }
    // Half a second of actual silence.
    for (let i = 0; i < 50; i += 1) {
      evidence.push(evidenceAt(time, null, 0.1, 0.0001));
      time += 0.01;
    }
    for (let i = 0; i < 40; i += 1) {
      evidence.push(evidenceAt(time, 64, 0.88, 0.05));
      time += 0.01;
    }

    const { notes } = chain(evidence);

    expect(notes.length).toBe(2);
    const gap = (notes[1] as { startSec: number }).startSec - (notes[0] as { endSec: number }).endSec;
    expect(gap).toBeGreaterThan(0.35);
  });
});
