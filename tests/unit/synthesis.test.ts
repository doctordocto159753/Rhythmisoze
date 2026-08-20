/**
 * US-0601 / US-0602 - the instrument registry and the synthesis adapter.
 *
 * The registry test is the machine half of "CI or review checklist catches
 * unregistered assets": an instrument without a licence, without provenance or
 * without a preview cannot reach a user, because this fails first.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MELODY_INSTRUMENT,
  DEFAULT_RHYTHM_INSTRUMENT,
  DRUM_SPECS,
  INSTRUMENTS,
  ProceduralEngine,
  SampleEngine,
  VOICE_SPECS,
  auditRegistry,
  getInstrument,
  instrumentsForMode,
  resolveInstrument,
} from '@synthesis';

describe('instrument registry', () => {
  it('passes its own audit', () => {
    const audit = auditRegistry();
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('meets the PRD minimum of eight melody instruments', () => {
    expect(instrumentsForMode('melody').length).toBeGreaterThanOrEqual(8);
  });

  it('registers at least one drum kit for the rhythm mode', () => {
    expect(instrumentsForMode('rhythm').length).toBeGreaterThanOrEqual(1);
  });

  it('gives every instrument a licence and a documented source', () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.license.spdx.length).toBeGreaterThan(0);
      expect(instrument.license.source.length).toBeGreaterThan(0);
    }
  });

  it('names every instrument in both locales', () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.name.en.trim().length).toBeGreaterThan(0);
      expect(instrument.name.fa.trim().length).toBeGreaterThan(0);
      // A Persian name that is just the English one is an untranslated stub.
      expect(instrument.name.fa).not.toBe(instrument.name.en);
    }
  });

  it('gives every instrument a voice the engine can actually produce', () => {
    for (const instrument of INSTRUMENTS) {
      const hasVoice =
        instrument.mode === 'rhythm'
          ? DRUM_SPECS[instrument.id] !== undefined
          : VOICE_SPECS[instrument.id] !== undefined;
      expect({ id: instrument.id, hasVoice }).toEqual({ id: instrument.id, hasVoice: true });
    }
  });

  it('keeps every General MIDI program in range', () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.gmProgram).toBeGreaterThanOrEqual(0);
      expect(instrument.gmProgram).toBeLessThanOrEqual(127);
    }
  });

  it('gives every instrument a playable range wide enough to be useful', () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.range.high - instrument.range.low).toBeGreaterThanOrEqual(11);
      expect(instrument.range.low).toBeGreaterThanOrEqual(0);
      expect(instrument.range.high).toBeLessThanOrEqual(127);
    }
  });

  it('has previews inside each instrument range', () => {
    for (const instrument of INSTRUMENTS.filter((i) => i.mode === 'melody')) {
      for (const note of instrument.previewPattern) {
        expect(note.pitch).toBeGreaterThanOrEqual(instrument.range.low);
        expect(note.pitch).toBeLessThanOrEqual(instrument.range.high);
        expect(note.endSec).toBeGreaterThan(note.startSec);
      }
    }
  });

  it('declares no sample pack without a size', () => {
    for (const instrument of INSTRUMENTS) {
      if (instrument.samplePack !== null) {
        expect(typeof instrument.samplePackBytes).toBe('number');
      }
    }
  });
});

describe('instrument resolution', () => {
  it('finds a registered instrument', () => {
    expect(getInstrument('piano')?.id).toBe('piano');
  });

  it('returns undefined for an unknown id rather than guessing', () => {
    expect(getInstrument('theremin')).toBeUndefined();
  });

  it('falls back to the mode default for an unknown id', () => {
    expect(resolveInstrument('theremin', 'melody').id).toBe(DEFAULT_MELODY_INSTRUMENT);
    expect(resolveInstrument('theremin', 'rhythm').id).toBe(DEFAULT_RHYTHM_INSTRUMENT);
  });

  it('does not return a melody instrument for the rhythm mode', () => {
    // A stored sketch switching mode must not end up with a piano on a kit.
    expect(resolveInstrument('piano', 'rhythm').mode).toBe('rhythm');
    expect(resolveInstrument('trap-kit', 'melody').mode).toBe('melody');
  });
});

describe('engine selection', () => {
  const procedural = new ProceduralEngine();
  const sample = new SampleEngine();

  it('lets the procedural engine voice every registered instrument', () => {
    for (const instrument of INSTRUMENTS) {
      expect({ id: instrument.id, ok: procedural.supports(instrument) }).toEqual({
        id: instrument.id,
        ok: true,
      });
    }
  });

  it('leaves the sample engine inactive until an instrument declares a pack', () => {
    // Documented state, not an oversight: no licensed sample pack ships yet.
    // See ADR-002 and docs/licenses/instruments.md.
    for (const instrument of INSTRUMENTS) {
      expect(sample.supports(instrument)).toBe(instrument.samplePack !== null);
    }
  });
});

describe('voice recipes', () => {
  it('gives every melodic voice a non-silent partial series', () => {
    for (const [id, voice] of Object.entries(VOICE_SPECS)) {
      const total = voice.partials.reduce((sum, p) => sum + p, 0);
      expect({ id, positive: total > 0 }).toEqual({ id, positive: true });
      expect(voice.gain).toBeGreaterThan(0);
      expect(voice.gain).toBeLessThanOrEqual(1);
    }
  });

  it('gives every envelope a real attack and release', () => {
    for (const [id, voice] of Object.entries(VOICE_SPECS)) {
      expect({ id, ok: voice.envelope.attackSec > 0 }).toEqual({ id, ok: true });
      expect({ id, ok: voice.envelope.releaseSec > 0 }).toEqual({ id, ok: true });
      expect(voice.envelope.sustain).toBeGreaterThanOrEqual(0);
      expect(voice.envelope.sustain).toBeLessThanOrEqual(1);
    }
  });

  it('gives each kit all three MVP drum classes', () => {
    for (const [id, kit] of Object.entries(DRUM_SPECS)) {
      expect({ id, keys: Object.keys(kit).sort() }).toEqual({
        id,
        keys: ['hat', 'kick', 'snare'],
      });
    }
  });

  it('makes the two kits audibly different rather than a rename', () => {
    const marching = DRUM_SPECS['marching-drum'];
    const trap = DRUM_SPECS['trap-kit'];
    expect(marching).toBeDefined();
    expect(trap).toBeDefined();
    expect(trap?.kick.toneDecaySec).not.toBe(marching?.kick.toneDecaySec);
    expect(trap?.hat.noiseHz).not.toBe(marching?.hat.noiseHz);
  });
});
