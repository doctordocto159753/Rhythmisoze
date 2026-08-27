/**
 * The spectral register witness, on signals whose true octave is known exactly.
 *
 * Synthesised rather than recorded, because the property under test is the one
 * thing a recording cannot pin down: what the right answer is. Each fixture is
 * built to be a specific kind of hard.
 *
 *  - A plain harmonic tone, to show the witness confirms a correct reading.
 *  - A candidate sitting an octave below a full series, which is the failure
 *    this witness was built for.
 *  - A tone with strong even harmonics, where the octave-up hypothesis explains
 *    every partial it predicts and must still not win.
 *  - A real note whose fundamental has been rolled off to 15%, which is this
 *    witness's own error mode and has to stay shut.
 *  - Noise, where the right answer is to say nothing.
 *
 * The last three matter more than the first two. A witness that only passes the
 * easy cases is a witness that will move notes it should have left alone, and
 * this one is wired into the arbitration that decides register for the whole
 * product.
 */

import { describe, expect, it } from 'vitest';
import type { MonoAudio, NoteEvent } from '@contracts';
import { midiToHz } from '@/packages/audio-core/pitch';
import { DEFAULT_HARMONIC_OPTIONS, harmonicRegisterWitness } from '@evidence';

const SAMPLE_RATE = 44100;
const DURATION_SEC = 1;

/** A tone at `midi` whose partials have the given relative amplitudes. */
function tone(midi: number, amplitudes: readonly number[]): MonoAudio {
  const length = SAMPLE_RATE * DURATION_SEC;
  const samples = new Float32Array(length);
  const fundamental = midiToHz(midi);
  for (let index = 0; index < length; index += 1) {
    const seconds = index / SAMPLE_RATE;
    let value = 0;
    amplitudes.forEach((amplitude, position) => {
      if (amplitude === 0) return;
      const partial = position + 1;
      value += amplitude * Math.sin(2 * Math.PI * fundamental * partial * seconds);
    });
    samples[index] = value * 0.2;
  }
  return { samples, sampleRate: SAMPLE_RATE, durationSec: DURATION_SEC };
}

function noise(): MonoAudio {
  const length = SAMPLE_RATE * DURATION_SEC;
  const samples = new Float32Array(length);
  // Deterministic, so a failure is reproducible rather than a coin flip.
  let seed = 12345;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    samples[index] = (seed / 2147483648) * 0.4 - 0.2;
  }
  return { samples, sampleRate: SAMPLE_RATE, durationSec: DURATION_SEC };
}

const candidate = (pitch: number): NoteEvent[] => [
  { startSec: 0, endSec: DURATION_SEC, pitch, velocity: 90 },
];

describe('harmonicRegisterWitness', () => {
  it('confirms a candidate that matches the recording', () => {
    const audio = tone(57, [1, 0.5, 0.33, 0.25, 0.2, 0.16]);
    const witness = harmonicRegisterWitness(audio, candidate(57));
    expect(witness.engineId).toBe('harmonic-spectrum');
    expect(witness.notes).toHaveLength(1);
    expect(witness.notes[0]?.pitch).toBe(57);
  });

  it('names the octave above when the candidate has locked onto a subharmonic', () => {
    // The failure this witness exists for. The recording is a full series on
    // A3; the tracker reports A2, an octave low, which is what YIN does when it
    // finds a period twice the true one. The hypothesis at A2 has to explain an
    // empty slot where its fundamental should be, and cannot.
    const audio = tone(57, [1, 0.6, 0.45, 0.3, 0.2, 0.15]);
    const witness = harmonicRegisterWitness(audio, candidate(45));
    expect(witness.notes[0]?.pitch).toBe(57);
  });

  it('abstains when the octave above explains nearly as much as the candidate', () => {
    // Even partials as strong as the fundamental. Everything the hypothesis an
    // octave up predicts is present, so it scores nearly as well while
    // explaining nothing extra — the exact trap that makes a harmonic sum
    // unsafe on its own.
    //
    // The right answer is silence, not confirmation. Confirming would be
    // counted by the arbitration as a second engine corroborating the
    // candidate, and this witness has not established anything of the sort.
    const audio = tone(57, [1, 1, 0.5, 1, 0.3, 0.9]);
    expect(harmonicRegisterWitness(audio, candidate(57)).notes).toHaveLength(0);
  });

  it('holds its ground on a note whose fundamental the microphone rolled off', () => {
    // The witness's error mode, pinned at the boundary that keeps it shut.
    //
    // Weighting partials by 1/n puts the most weight on the fundamental, which
    // is what lets a subharmonic reading lose — and it also means a real note
    // with a weak fundamental can be pushed an octave up, because the
    // hypothesis above starts its sum on a strong partial. That bias is not a
    // bug to be tuned out: weighting partials equally removes it and was
    // measured to lose every correction the witness gets right.
    //
    // What contains it is the decision ratio. This signal is a real A3 with its
    // fundamental at 15%, and the octave above only wins here below a ratio of
    // about 1.05 — well under the shipped 1.25 — while lifting a candidate that
    // sits an octave low survives past 2.1. Raising the default toward 2 would
    // therefore not buy safety, and lowering it below 1.06 would open this.
    const rolledOff = tone(57, [0.15, 1, 0.8, 0.6, 0.45, 0.35]);
    expect(harmonicRegisterWitness(rolledOff, candidate(57)).notes).toHaveLength(0);
    expect(harmonicRegisterWitness(rolledOff, candidate(57), { decisionRatio: 1.02 }).notes[0]?.pitch).toBe(69);
  });

  it('says nothing about noise', () => {
    const witness = harmonicRegisterWitness(noise(), candidate(57));
    expect(witness.notes).toHaveLength(0);
  });

  it('says nothing about a span too short to hold a spectrum', () => {
    const audio = tone(57, [1, 0.5, 0.33]);
    const short: NoteEvent[] = [
      { startSec: 0, endSec: DEFAULT_HARMONIC_OPTIONS.minDurationSec / 2, pitch: 57, velocity: 90 },
    ];
    expect(harmonicRegisterWitness(audio, short).notes).toHaveLength(0);
  });

  it('reads the same octave whatever the recording was sampled at', () => {
    // The witness resamples to a fixed analysis rate precisely so that the
    // device a take was recorded on cannot decide a close call.
    const at = (sampleRate: number): number | undefined => {
      const length = sampleRate * DURATION_SEC;
      const samples = new Float32Array(length);
      const fundamental = midiToHz(45);
      for (let index = 0; index < length; index += 1) {
        const seconds = index / sampleRate;
        let value = 0;
        for (const [position, amplitude] of [0.7, 0.5, 0.4, 0.3].entries()) {
          value += amplitude * Math.sin(2 * Math.PI * fundamental * (position + 3) * seconds);
        }
        samples[index] = value * 0.2;
      }
      const audio: MonoAudio = { samples, sampleRate, durationSec: DURATION_SEC };
      return harmonicRegisterWitness(audio, candidate(69)).notes[0]?.pitch;
    };
    expect(at(44100)).toBe(at(48000));
  });

  it('abstains rather than guessing when no octave is clearly better', () => {
    // A ratio high enough that nothing can clear it. The witness has to fall
    // silent, not fall back on the candidate's own pitch: silence is read as no
    // evidence, and agreement would be counted as corroboration.
    const audio = tone(57, [1, 0.5, 0.33, 0.25]);
    const witness = harmonicRegisterWitness(audio, candidate(57), { decisionRatio: 1e6 });
    expect(witness.notes).toHaveLength(0);
  });
});
