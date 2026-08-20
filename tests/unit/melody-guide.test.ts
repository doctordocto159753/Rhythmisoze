import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  guideMelodyCandidates,
  notesAreMonophonic,
  segmentNotes,
  type MelodyGuide,
} from '@audio-core';
import { pitchAgreement, refine } from '@retouch';

interface RegressionFixture {
  referenceNotes: NoteEvent[];
  basicPitchCandidates: NoteEvent[];
}

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests', 'fixtures', 'transcription', 'recording-8-regression.json'),
    'utf8',
  ),
) as RegressionFixture;

describe('YIN-guided melody regression', () => {
  const guide: MelodyGuide = {
    frames: [],
    notes: fixture.referenceNotes,
    register: {
      lowMidi: 57,
      highMidi: 68,
      centerMidi: 62,
      minFrequencyHz: 220,
      maxFrequencyHz: 415.3,
    },
  };

  it('rejects the sustained A2/A1 subharmonics and emits one melody line', () => {
    const notes = guideMelodyCandidates(fixture.basicPitchCandidates, guide);

    expect(notesAreMonophonic(notes)).toBe(true);
    expect(notes.some((note) => note.pitch === 33 || note.pitch === 45)).toBe(false);
    expect(notes.every((note) => note.pitch >= 60 && note.pitch <= 65)).toBe(true);
    expect(pitchAgreement(notes, fixture.referenceNotes, 1)).toBeGreaterThanOrEqual(0.75);
  });

  it('carries measured YIN clarity into note confidence', () => {
    const frames = Array.from({ length: 12 }, (_, index) => ({
      timeSec: index * 0.01,
      frequencyHz: 261.63,
      clarity: index < 6 ? 0.8 : 0.9,
      rms: 0.1,
    }));
    const notes = segmentNotes(
      frames,
      {
        minClarity: 0.72,
        minRms: 0.006,
        maxDriftSemitones: 0.9,
        maxGapFrames: 3,
        minDurationSec: 0.05,
      },
      0.01,
    );

    expect(notes).toHaveLength(1);
    expect(notes[0]?.confidence).toBeCloseTo(0.85, 5);
    expect(notes[0]?.confidence).not.toBe(1);
  });

  it('keeps maximum Clean within five points of the guided raw contour', () => {
    const notes = guideMelodyCandidates(fixture.basicPitchCandidates, guide);
    const raw = refine(
      { notes, drums: [] },
      { bpm: 100, mode: 'melody', amount: 0, referenceNotes: fixture.referenceNotes },
    );
    const clean = refine(
      { notes, drums: [] },
      { bpm: 100, mode: 'melody', amount: 100, referenceNotes: fixture.referenceNotes },
    );
    const rawAgreement = pitchAgreement(raw.notes, fixture.referenceNotes, 1);
    const cleanAgreement = pitchAgreement(clean.notes, fixture.referenceNotes, 1);

    expect(cleanAgreement).toBeGreaterThanOrEqual(rawAgreement - 0.05);
    expect(clean.notes.some((note) => note.pitch < 48)).toBe(false);
    expect(clean.notes.length).toBeLessThanOrEqual(raw.notes.length);
    expect(movementDirections(clean.notes)).toEqual(movementDirections(raw.notes));
    expect(clean.qualityGuard).not.toBeNull();
  });

  it('rolls back pitch cleanup when it would reinforce an octave error', () => {
    const shortReference = fixture.referenceNotes.map((note) => ({
      ...note,
      endSec: note.startSec + 0.08,
    }));
    const polluted = [
      { startSec: 0, endSec: 17.6, pitch: 45, velocity: 78, confidence: 0.8 },
      ...shortReference,
    ];
    const result = refine(
      { notes: polluted, drums: [] },
      { bpm: 100, mode: 'melody', amount: 100, referenceNotes: shortReference },
    );

    expect(result.qualityGuard?.triggered).toBe(true);
    expect(result.qualityGuard?.reasons).toContain('agreement_drop');
  });
});

function movementDirections(notes: readonly NoteEvent[]): number[] {
  const directions: number[] = [];
  for (let index = 1; index < notes.length; index += 1) {
    const delta = (notes[index]?.pitch ?? 0) - (notes[index - 1]?.pitch ?? 0);
    directions.push(Math.sign(delta));
  }
  return directions;
}
