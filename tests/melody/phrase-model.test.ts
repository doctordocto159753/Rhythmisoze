import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@contracts';
import {
  buildMusicalPhraseModel,
  type ContinuityFrame,
} from '@/packages/musical-phrase';

function note(pitch: number, startSec: number, endSec: number): NoteEvent {
  return { pitch, startSec, endSec, velocity: 90, confidence: 0.9 };
}

function frames(
  durationSec: number,
  energyAt: (timeSec: number) => number,
): ContinuityFrame[] {
  const out: ContinuityFrame[] = [];
  for (let timeSec = 0; timeSec <= durationSec; timeSec += 0.01) {
    const rounded = Number(timeSec.toFixed(4));
    out.push({
      timeSec: rounded,
      midiPitch: null,
      candidateMidi: null,
      rms: energyAt(rounded),
      clarity: 0.2,
      voiced: false,
    });
  }
  return out;
}

describe('musical phrase representation', () => {
  it('reconstructs an energetic syllable transition without moving an onset or pitch', () => {
    const source = [
      note(60, 0.1, 0.5),
      note(62, 0.66, 1.06),
      note(64, 1.22, 1.62),
      note(65, 1.78, 2.18),
    ];
    // The pitch tracker lost each consonant, but the performance never became
    // quiet. This is the physical distinction between "dam-bali" and a rest.
    const evidence = frames(2.3, (timeSec) =>
      timeSec >= 0.08 && timeSec <= 2.2 ? 0.035 : 0.0002,
    );
    const model = buildMusicalPhraseModel(source, {
      sourceKind: 'voice',
      frames: evidence,
      onsetsSec: [0.1, 0.66, 1.22, 1.78],
    });

    expect(model.sourceEvidence.notes).toEqual(source);
    expect(model.sourceEvidence.notes).not.toBe(source);
    expect(model.interpretedNotes.map((item) => item.startSec)).toEqual(
      source.map((item) => item.startSec),
    );
    expect(model.interpretedNotes.map((item) => item.pitch)).toEqual(
      source.map((item) => item.pitch),
    );
    expect(model.interpretedNotes.slice(0, -1).map((item) => item.endSec)).toEqual([
      0.66,
      1.22,
      1.78,
    ]);
    expect(model.phrases).toHaveLength(1);
    expect(model.phrases[0]?.contour).toEqual([2, 2, 1]);
    expect(model.connections.every((item) => item.articulation === 'rearticulated')).toBe(true);
    expect(model.metrics).toMatchObject({
      interpretedInputGapSec: 0.48,
      interpretedGapSec: 0,
      reconstructedGapSec: 0.48,
      connectedTransitions: 3,
      detachedTransitions: 0,
    });
  });

  it('keeps a real quiet rest and splits the phrases there', () => {
    const source = [note(69, 0.1, 0.5), note(71, 0.68, 1.08), note(72, 1.7, 2.1)];
    const evidence = frames(2.2, (timeSec) => {
      if (timeSec >= 0.08 && timeSec < 1.12) return 0.035;
      if (timeSec >= 1.66 && timeSec <= 2.12) return 0.035;
      return 0.0001;
    });
    const model = buildMusicalPhraseModel(source, {
      sourceKind: 'voice',
      frames: evidence,
      onsetsSec: [0.1, 0.68, 1.7],
    });

    expect(model.interpretedNotes[0]?.endSec).toBe(0.68);
    expect(model.interpretedNotes[1]?.endSec).toBe(1.08);
    expect(model.connections.map((item) => item.articulation)).toEqual([
      'rearticulated',
      'detached',
    ]);
    expect(model.phrases).toHaveLength(2);
  });

  it('does not flatten or lengthen polyphonic material', () => {
    const source = [
      note(60, 0, 0.8),
      note(64, 0, 0.8),
      note(67, 0, 0.8),
      note(62, 1, 1.8),
    ];
    const model = buildMusicalPhraseModel(source, { sourceKind: 'polyphonic' });

    expect(model.interpretedNotes).toEqual(source);
    expect(model.connections).toEqual([]);
    expect(model.phrases).toEqual([]);
    expect(model.metrics.reconstructedGapSec).toBe(0);
  });

  it('describes imported MIDI phrases while preserving every symbolic duration exactly', () => {
    const source = [
      note(60, 0, 0.31),
      note(62, 0.47, 0.81),
      note(64, 1.8, 2.17),
    ];
    const model = buildMusicalPhraseModel(source, { sourceKind: 'symbolic' });

    expect(model.sourceEvidence.notes).toEqual(source);
    expect(model.interpretedNotes).toEqual(source);
    expect(model.phrases).toHaveLength(2);
    expect(model.metrics.reconstructedGapSec).toBe(0);
  });
});
