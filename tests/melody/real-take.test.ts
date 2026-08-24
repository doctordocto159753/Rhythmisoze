/**
 * The real failing take, as a regression fixture.
 *
 * ## What is committed and why it is not the recording
 *
 * `tests/fixtures/melody/real-take-contour.json` holds the per-frame YIN
 * evidence measured from a real 31.2 second hummed take: candidate F0, clarity
 * and energy at a 10 ms hop. Derived measurements only — no samples, no phase,
 * no timbre — so it is 46 KB rather than half a megabyte and the person's voice
 * is not in the repository.
 *
 * Starting from the evidence rather than the audio skips YIN, which is exactly
 * right: YIN was never the problem. It measured this performance well
 * throughout, at a median error inside a quarter of a semitone. Everything
 * after it discarded the measurements. This fixture pins the stages that did
 * the discarding.
 *
 * ## The numbers this replaced
 *
 * Scored against the same reference contour, the old pipeline and the new one:
 *
 * ```
 *                        before    after
 * accepted contour        7.45 s   19.73 s
 * notes                     30       44
 * voiced recall           0.66     0.90
 * false-voiced ratio      0.34     0.27
 * merge ratio             0.30     0.05
 * fragmentation ratio     0.09     0.05
 * regions with no note      14        5
 * wrong-semitone regions  6 / 29   1 / 38
 * ```
 *
 * The bounds below sit clear of the old behaviour in every direction, and clear
 * of the new behaviour by enough that an honest improvement elsewhere does not
 * trip them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideVoicing,
  generateMelodyNoteEvents,
  measureTranscription,
  segmentPitchContour,
  smoothPitchContour,
  trustedRegionsFromContour,
  type FrameEvidence,
  type PitchFrame,
} from '@/packages/melody-extraction';
import { buildMusicalPhraseModel } from '@/packages/musical-phrase';

interface ContourFixture {
  durationSec: number;
  hopSec: number;
  energyGate: number;
  candidateMidiX100: number[];
  clarityX1000: number[];
  rmsX1000000: number[];
}

function loadFixture(): { evidence: FrameEvidence[]; energyGate: number; durationSec: number } {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/melody/real-take-contour.json'), 'utf8'),
  ) as ContourFixture;

  const evidence = raw.candidateMidiX100.map((packed, index): FrameEvidence => {
    const candidateMidi = packed < 0 ? null : packed / 100;
    const clarity = (raw.clarityX1000[index] ?? 0) / 1000;
    const rms = (raw.rmsX1000000[index] ?? 0) / 1_000_000;
    return {
      timeSec: Number((index * raw.hopSec).toFixed(4)),
      candidateHz: candidateMidi === null ? null : 440 * 2 ** ((candidateMidi - 69) / 12),
      candidateMidi,
      clarity,
      rms,
      // The composite the tracker would have produced. Only the quality scorer
      // reads it; voicing keys on clarity and energy separately.
      confidence: clarity,
    };
  });
  return { evidence, energyGate: raw.energyGate, durationSec: raw.durationSec };
}

function runPipeline(): { frames: PitchFrame[]; notes: ReturnType<typeof generateMelodyNoteEvents> } {
  const { evidence, energyGate } = loadFixture();
  const tracked = decideVoicing(evidence, energyGate);
  const contour = smoothPitchContour(tracked);
  const segments = segmentPitchContour(contour.frames, {
    minDurationSec: 0.12,
    register: contour.range
      ? { lowMidi: contour.range.lowMidi, highMidi: contour.range.highMidi }
      : null,
  });
  return { frames: contour.frames, notes: generateMelodyNoteEvents(segments) };
}

describe('the real hummed take', () => {
  const { evidence } = loadFixture();
  const { frames, notes } = runPipeline();
  const trusted = trustedRegionsFromContour(frames);
  const metrics = measureTranscription(notes, trusted);

  it('has far more measurable pitch in it than the old reading kept', () => {
    // The premise. If this stops being true the fixture has been regenerated
    // from different audio and the bounds below mean nothing.
    const measurable = evidence.filter(
      (frame) => frame.candidateMidi !== null && frame.clarity >= 0.4,
    ).length;
    expect(measurable * 0.01).toBeGreaterThan(15);
  });

  it('keeps most of the performance as accepted contour', () => {
    // 7.45 s before, 19.73 s after, out of 31.2 s of recording.
    const acceptedSec = frames.filter((frame) => frame.midiPitch !== null).length * 0.01;
    expect(acceptedSec).toBeGreaterThan(15);
  });

  it('represents the stable material as notes', () => {
    // 0.66 before, 0.90 after.
    expect(metrics.voicedRecall, JSON.stringify(metrics)).toBeGreaterThan(0.82);
    expect(metrics.missedRegions).toBeLessThanOrEqual(8);
  });

  it('does not buy that coverage with invented notes', () => {
    // The paired bound. Recall is trivially raised by emitting notes over
    // everything, and this is what says that is not what happened: false-voiced
    // went *down* while recall went up.
    expect(metrics.falseVoicedRatio, JSON.stringify(metrics)).toBeLessThan(0.3);
  });

  it('stops averaging adjacent notes together', () => {
    // 0.30 before, 0.05 after. This is the "G4 and F4 became F#4" family.
    expect(metrics.mergeRatio, JSON.stringify(metrics)).toBeLessThan(0.12);
  });

  it('does not cut sustained pitches into pieces', () => {
    expect(metrics.fragmentationRatio, JSON.stringify(metrics)).toBeLessThan(0.15);
  });

  it('keeps the pitch accuracy the tracker always had', () => {
    // Measured against a reference whose own median distance from a semitone
    // centre is 0.215, so anything near that is at the floor of what integer
    // MIDI can express.
    expect(metrics.pitchErrorSemitones, JSON.stringify(metrics)).toBeLessThan(0.3);
  });

  it('stays inside the register the singer actually used', () => {
    // The closing phrase used to walk up through 72, 73, 75, 77, 81, 82 — an
    // octave and a half above anything hummed — because each octave repair
    // became the reference for the next.
    const pitches = notes.map((note) => note.pitch);
    expect(Math.max(...pitches), JSON.stringify(notes)).toBeLessThanOrEqual(75);
    expect(Math.min(...pitches), JSON.stringify(notes)).toBeGreaterThanOrEqual(55);
  });

  it('adds phrase continuity without rewriting the real take evidence', () => {
    const phraseModel = buildMusicalPhraseModel(notes, {
      sourceKind: 'voice',
      frames,
    });
    expect(phraseModel.sourceEvidence.notes).toEqual(notes);
    expect(phraseModel.interpretedNotes.map((note) => note.startSec)).toEqual(
      notes.map((note) => note.startSec),
    );
    expect(phraseModel.interpretedNotes.map((note) => note.pitch)).toEqual(
      notes.map((note) => note.pitch),
    );
    expect(phraseModel.metrics.interpretedGapSec).toBeLessThanOrEqual(
      phraseModel.metrics.interpretedInputGapSec,
    );
    // 7.01 s of physical gaps becomes 4.72 s after 2.29 s of energetic
    // consonant/dropout transitions are interpreted as connected gestures.
    // The remaining rests stay explicit rather than being painted over.
    expect(phraseModel.metrics.reconstructedGapSec).toBeGreaterThan(1.5);
    expect(phraseModel.metrics.interpretedGapSec).toBeGreaterThan(4);
  });

  it('does not place a note over the silence before the first phrase', () => {
    // A single strong frame at 3.36 s used to open a region that the segment
    // consolidator then extended to the next real note at 5.13 s: one note over
    // 1.8 seconds of nothing.
    const firstStart = Math.min(...notes.map((note) => note.startSec));
    expect(firstStart).toBeGreaterThan(4.5);
  });
});
