/**
 * The ten ways a hummed phrase gets misread, one fixture each.
 *
 * ## What these exist to hold in place
 *
 * A real 31.2 s take produced 7 s of accepted contour and 30 notes. The pitch
 * in those notes was good — a median error near a fifth of a semitone — so
 * nothing sounded obviously wrong; two thirds of the performance was simply
 * missing. The cause was one gate: `confidence = clarity * (0.55 + 0.45 *
 * energy)` compared against a fixed floor, which reads a note's natural decay
 * as the note ending.
 *
 * Recall and false positives pull against each other, so every recovery test
 * here is paired with a rejection test. A change that admits the dropout cases
 * *and* the noise case is not an improvement, and the pairing is what makes
 * that visible rather than arguable.
 *
 * The synthetic fixtures are deliberately unkind: shaped noise mixed into the
 * tone, room tone rather than digital silence in the rests, and levels that
 * move the way a voice moves. Clean sine tones would pass under the old code
 * too and would prove nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PITCH_TRACKER_OPTIONS,
  decideVoicing,
  extractHumanMelody,
  measureTranscription,
  trackVoiceEvidence,
  type FrameEvidence,
  type TrustedRegion,
} from '@/packages/melody-extraction';
import { ramp, synthesizeVoice } from './helpers';

const A4 = 69;
const B4 = 71;

/** Notes whose pitch is within a semitone of `pitch`. */
function notesNear(
  notes: readonly { pitch: number; startSec: number; endSec: number }[],
  pitch: number,
) {
  return notes.filter((note) => Math.abs(note.pitch - pitch) <= 1);
}

function spanOf(notes: readonly { startSec: number; endSec: number }[]): number {
  return notes.reduce((sum, note) => sum + (note.endSec - note.startSec), 0);
}

describe('a sustained note interrupted by a confidence dropout', () => {
  /** One A4, held for two seconds, with the level collapsing for 100 ms in the middle. */
  const audio = synthesizeVoice({
    durationSec: 2.6,
    pitchAt: (t) => (t >= 0.3 && t < 2.3 ? A4 : null),
    // Not silence — a whisper. The pitch is still there and still A4; there is
    // simply almost no energy behind it, which is what a voice does mid-phrase.
    gainAt: (t) =>
      0.7 * ramp(t, 0.3, 0.36) * (1 - ramp(t, 2.24, 2.3)) * (t >= 1.2 && t < 1.3 ? 0.08 : 1),
    breathiness: 0.05,
  });

  it('stays one note across the dip', () => {
    const result = extractHumanMelody(audio);
    const held = notesNear(result.notes, A4);
    expect(held.length, JSON.stringify(result.notes)).toBe(1);
    // And it is the whole note, not the part before the dip.
    expect(spanOf(held)).toBeGreaterThan(1.6);
  });

  it('keeps the pitch it measured through the dip rather than losing it', () => {
    // The invariant the whole redesign turns on: a frame may be too weak to
    // *start* a note without its estimate being worthless.
    const tracked = trackVoiceEvidence(audio.samples, audio.sampleRate);
    const inDip = tracked.frames.filter((frame) => frame.timeSec >= 1.21 && frame.timeSec < 1.29);
    expect(inDip.length).toBeGreaterThan(4);
    const withCandidate = inDip.filter(
      (frame) => frame.candidateMidi !== null && Math.abs(frame.candidateMidi - A4) < 1.5,
    );
    expect(withCandidate.length / inDip.length).toBeGreaterThan(0.5);
  });
});

describe('a note followed by real silence', () => {
  const audio = synthesizeVoice({
    durationSec: 3.4,
    pitchAt: (t) => (t >= 0.3 && t < 1.2 ? A4 : t >= 2.4 && t < 3.1 ? A4 : null),
    // Two phrases with a real rest between them: the level goes to nothing and
    // stays there for over a second before the second phrase begins.
    gainAt: (t) =>
      0.7 *
      (t < 1.4
        ? ramp(t, 0.3, 0.36) * (1 - ramp(t, 1.14, 1.2))
        : ramp(t, 2.4, 2.46) * (1 - ramp(t, 3.04, 3.1))),
    breathiness: 0.04,
  });

  it('ends the note rather than bridging a rest', () => {
    const result = extractHumanMelody(audio);
    const held = notesNear(result.notes, A4);
    // Two separate notes with a rest between them, not one long one.
    expect(held.length, JSON.stringify(result.notes)).toBeGreaterThanOrEqual(2);
    const first = held[0];
    expect(first?.endSec).toBeLessThan(1.6);
  });
});

describe('one pitch, an uncertain patch, then the same pitch', () => {
  const audio = synthesizeVoice({
    durationSec: 2.8,
    pitchAt: (t) => (t >= 0.3 && t < 2.5 ? A4 : null),
    gainAt: (t) => 0.7 * ramp(t, 0.3, 0.36) * (1 - ramp(t, 2.44, 2.5)),
    // Heavy breath throughout, which is what actually costs YIN its clarity.
    breathiness: 0.16,
  });

  it('does not fragment into a run of short notes', () => {
    const result = extractHumanMelody(audio);
    const trusted: TrustedRegion[] = [{ startSec: 0.32, endSec: 2.48, midiPitch: A4 }];
    const metrics = measureTranscription(result.notes, trusted);
    expect(metrics.fragmentationRatio, JSON.stringify(result.notes)).toBeLessThanOrEqual(1);
    expect(metrics.voicedRecall).toBeGreaterThan(0.75);
    expect(metrics.pitchErrorSemitones).toBeLessThanOrEqual(0.5);
  });
});

describe('two adjacent notes', () => {
  const boundarySec = 1.35;
  const audio = synthesizeVoice({
    durationSec: 2.7,
    pitchAt: (t) => (t < 0.3 || t >= 2.4 ? null : t < boundarySec ? A4 : B4),
    gainAt: (t) => 0.7 * ramp(t, 0.3, 0.36) * (1 - ramp(t, 2.34, 2.4)),
    breathiness: 0.05,
  });

  it('becomes two notes with the boundary near the real transition', () => {
    const result = extractHumanMelody(audio);
    const low = notesNear(result.notes, A4);
    const high = notesNear(result.notes, B4);
    expect(low.length, JSON.stringify(result.notes)).toBeGreaterThanOrEqual(1);
    expect(high.length, JSON.stringify(result.notes)).toBeGreaterThanOrEqual(1);
    const transition = high[0]?.startSec ?? 0;
    expect(Math.abs(transition - boundarySec)).toBeLessThan(0.15);
  });

  it('does not average the two into one note between them', () => {
    const result = extractHumanMelody(audio);
    const trusted: TrustedRegion[] = [
      { startSec: 0.35, endSec: boundarySec, midiPitch: A4 },
      { startSec: boundarySec, endSec: 2.36, midiPitch: B4 },
    ];
    const metrics = measureTranscription(result.notes, trusted);
    expect(metrics.mergeRatio, JSON.stringify(result.notes)).toBe(0);
    // The pitch between A4 and B4 is A#4, and it must not appear.
    expect(result.notes.some((note) => note.pitch === 70)).toBe(false);
  });
});

describe('vibrato around one pitch', () => {
  const audio = synthesizeVoice({
    durationSec: 2.6,
    pitchAt: (t) =>
      t >= 0.3 && t < 2.3 ? A4 + 0.55 * Math.sin(2 * Math.PI * 5.4 * (t - 0.3)) : null,
    gainAt: (t) => 0.7 * ramp(t, 0.3, 0.36) * (1 - ramp(t, 2.24, 2.3)),
    breathiness: 0.05,
  });

  it('is one note, not a tremble of many', () => {
    const result = extractHumanMelody(audio);
    expect(result.notes.length, JSON.stringify(result.notes)).toBe(1);
    expect(result.notes[0]?.pitch).toBe(A4);
  });

  it('keeps the wobble in the contour rather than flattening it', () => {
    // Unprocessed is meant to be the closest reading of what happened. The note
    // is one note; the contour under it still shows the vibrato.
    const result = extractHumanMelody(audio);
    const voiced = result.frames
      .filter((frame) => frame.midiPitch !== null && frame.timeSec > 0.5 && frame.timeSec < 2.1)
      .map((frame) => frame.midiPitch as number);
    const spread = Math.max(...voiced) - Math.min(...voiced);
    expect(spread).toBeGreaterThan(0.3);
  });
});

describe('a portamento between two pitches', () => {
  const audio = synthesizeVoice({
    durationSec: 3.0,
    pitchAt: (t) => {
      if (t < 0.3 || t >= 2.7) return null;
      if (t < 1.0) return A4;
      if (t < 1.8) return A4 + ((B4 + 2 - A4) * (t - 1.0)) / 0.8;
      return B4 + 2;
    },
    gainAt: (t) => 0.7 * ramp(t, 0.3, 0.36) * (1 - ramp(t, 2.64, 2.7)),
    breathiness: 0.05,
  });

  it('keeps the endpoints and does not invent a note on the way', () => {
    const result = extractHumanMelody(audio);
    expect(notesNear(result.notes, A4).length, JSON.stringify(result.notes)).toBeGreaterThanOrEqual(1);
    expect(notesNear(result.notes, B4 + 2).length, JSON.stringify(result.notes)).toBeGreaterThanOrEqual(1);
    // A slide is not a chromatic scale. The pitches in between may appear at
    // most briefly; none of them should be a note the length of the endpoints.
    const settled = result.notes.filter((note) => note.endSec - note.startSec > 0.4);
    for (const note of settled) {
      expect(
        Math.abs(note.pitch - A4) <= 1 || Math.abs(note.pitch - (B4 + 2)) <= 1,
        JSON.stringify(result.notes),
      ).toBe(true);
    }
  });
});

describe('a phrase that begins weakly', () => {
  const attackSec = 0.5;
  const audio = synthesizeVoice({
    durationSec: 2.4,
    pitchAt: (t) => (t >= attackSec && t < 2.1 ? A4 : null),
    // A long breathy swell rather than a clean attack: the pitch is correct
    // from the start, but the first 200 ms are far too weak to open a note on.
    gainAt: (t) => 0.75 * ramp(t, attackSec, attackSec + 0.32) * (1 - ramp(t, 2.04, 2.1)),
    breathiness: 0.12,
  });

  it('recovers the attack once the pitch is established', () => {
    const result = extractHumanMelody(audio);
    const held = notesNear(result.notes, A4);
    expect(held.length, JSON.stringify(result.notes)).toBeGreaterThanOrEqual(1);
    const start = held[0]?.startSec ?? 99;
    // Without the look-back the note begins where the swell got loud, a third
    // of a second after the person started singing.
    expect(start).toBeLessThan(attackSec + 0.3);
  });
});

describe('noise and silence', () => {
  it('produces no notes from room tone', () => {
    const audio = synthesizeVoice({
      durationSec: 3,
      pitchAt: () => null,
      breathiness: 0,
    });
    expect(extractHumanMelody(audio).notes).toEqual([]);
  });

  it('produces no notes from broadband noise at speaking level', () => {
    // Loud enough to clear any energy gate; no periodicity for clarity to find.
    const sampleRate = 16_000;
    const samples = new Float32Array(sampleRate * 3);
    let state = 0x9e3779b9;
    for (let index = 0; index < samples.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      samples[index] = ((state / 0x7fffffff) % 1) * 0.5;
    }
    const result = extractHumanMelody({ samples, sampleRate, durationSec: 3 });
    expect(result.notes.length, JSON.stringify(result.notes)).toBeLessThanOrEqual(1);
    expect(result.quality.clear).toBe(false);
  });
});

describe('the voicing rule itself', () => {
  const gate = 0.02;
  const frame = (
    timeSec: number,
    candidateMidi: number | null,
    clarity: number,
    rms: number,
  ): FrameEvidence => ({
    timeSec,
    candidateHz: candidateMidi === null ? null : 440 * 2 ** ((candidateMidi - 69) / 12),
    candidateMidi,
    clarity,
    rms,
    confidence: clarity,
  });

  it('needs more evidence to start a note than to continue one', () => {
    const weak = DEFAULT_PITCH_TRACKER_OPTIONS.sustainClarity + 0.02;
    // A run of frames that would all fail the onset test on their own.
    const onlyWeak = Array.from({ length: 20 }, (_, i) => frame(i * 0.01, A4, weak, gate * 2));
    expect(decideVoicing(onlyWeak, gate).every((f) => !f.voiced)).toBe(true);

    // The same run, preceded by frames strong enough to open a region.
    const opened = [
      ...Array.from({ length: 5 }, (_, i) => frame(i * 0.01, A4, 0.9, gate * 3)),
      ...Array.from({ length: 20 }, (_, i) => frame((i + 5) * 0.01, A4, weak, gate * 2)),
    ];
    expect(decideVoicing(opened, gate).every((f) => f.voiced)).toBe(true);
  });

  it('will not continue a region through a pitch that disagrees with it', () => {
    // This is what stops the low sustain threshold from admitting noise: a weak
    // frame is only kept if it agrees with the note already sounding.
    const frames = [
      ...Array.from({ length: 6 }, (_, i) => frame(i * 0.01, A4, 0.9, gate * 3)),
      ...Array.from({ length: 8 }, (_, i) => frame((i + 6) * 0.01, A4 - 9, 0.4, gate * 2)),
    ];
    const decided = decideVoicing(frames, gate);
    expect(decided.slice(0, 6).every((f) => f.voiced)).toBe(true);
    expect(decided.slice(6).some((f) => f.voiced)).toBe(false);
  });

  it('keeps the estimate on every frame, voiced or not', () => {
    const frames = Array.from({ length: 12 }, (_, i) => frame(i * 0.01, A4, 0.2, gate * 0.1));
    const decided = decideVoicing(frames, gate);
    expect(decided.every((f) => !f.voiced)).toBe(true);
    expect(decided.every((f) => f.candidateMidi === A4)).toBe(true);
    expect(decided.every((f) => f.midiPitch === null)).toBe(true);
  });

  it('refuses to call a single strong frame a note', () => {
    const frames = [
      ...Array.from({ length: 4 }, (_, i) => frame(i * 0.01, null, 0.1, gate * 0.2)),
      frame(0.04, A4, 0.95, gate * 4),
      ...Array.from({ length: 4 }, (_, i) => frame((i + 5) * 0.01, null, 0.1, gate * 0.2)),
    ];
    expect(decideVoicing(frames, gate).every((f) => !f.voiced)).toBe(true);
  });
});
