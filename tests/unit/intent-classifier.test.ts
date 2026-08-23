/**
 * Intent classification, tested on synthesised signals with known answers.
 *
 * The failure this guards against is the one the brief describes: every upload
 * went into Melody Mode, so a guitar take was handed to a monophonic voice
 * tracker and a beatbox take was asked for its fundamental. The classifier's
 * job is to route correctly — and, when it cannot tell, to say so rather than
 * to guess.
 *
 * These fixtures are synthetic on purpose. A synthesised sung vowel really is
 * a voice-shaped signal (continuous, harmonic, soft attack) and a synthesised
 * pluck really is instrument-shaped (harmonic but re-attacked every note), so
 * the assertions have a right answer. Accuracy on *human* recordings is a
 * corpus question, tracked in docs/benchmarks.
 */

import { describe, expect, it } from 'vitest';
import type { MonoAudio } from '@contracts';
import {
  InputClassifier,
  classifyInput,
  classifyIntent,
  extractIntentFeatures,
  INTENT_ASK_THRESHOLD,
} from '@intent';

const RATE = 44100;

function mono(samples: Float32Array): MonoAudio {
  return { samples, sampleRate: RATE, durationSec: samples.length / RATE };
}

/** A sung phrase: continuous, harmonic, gliding between notes, soft attacks. */
function sungPhrase(): MonoAudio {
  const notes = [220, 246.94, 261.63, 293.66, 261.63];
  const noteSec = 0.7;
  const total = Math.round(notes.length * noteSec * RATE);
  const out = new Float32Array(total);
  let phase = 0;

  for (let i = 0; i < total; i += 1) {
    const t = i / RATE;
    const index = Math.min(notes.length - 1, Math.floor(t / noteSec));
    const within = (t % noteSec) / noteSec;
    // Glide into the next note over the last 15% - this continuity is the
    // feature that distinguishes a voice from a plucked instrument.
    const next = notes[Math.min(notes.length - 1, index + 1)] as number;
    const base = notes[index] as number;
    const hz = within > 0.85 ? base + (next - base) * ((within - 0.85) / 0.15) : base;
    const vibrato = 1 + 0.005 * Math.sin(2 * Math.PI * 5.2 * t);
    phase += (2 * Math.PI * hz * vibrato) / RATE;
    // Soft attack only at the very start of the phrase; no re-attack per note.
    const envelope = Math.min(1, t / 0.25) * Math.min(1, (notes.length * noteSec - t) / 0.3);
    out[i] = 0.45 * envelope * (Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase));
  }
  return mono(out);
}

/** A plucked instrument: harmonic, but a sharp attack and decay per note. */
function pluckedPhrase(): MonoAudio {
  const notes = [196, 246.94, 293.66, 246.94, 196, 164.81];
  const noteSec = 0.42;
  const total = Math.round(notes.length * noteSec * RATE);
  const out = new Float32Array(total);

  notes.forEach((hz, index) => {
    const start = Math.round(index * noteSec * RATE);
    const length = Math.round(noteSec * RATE);
    for (let i = 0; i < length && start + i < total; i += 1) {
      const t = i / RATE;
      // Instant attack, exponential decay: the envelope restarts every note.
      const envelope = Math.exp(-t * 6.5) * (t < 0.002 ? t / 0.002 : 1);
      const phase = 2 * Math.PI * hz * t;
      out[start + i] =
        (out[start + i] as number) +
        0.5 *
        envelope *
        (Math.sin(phase) + 0.55 * Math.sin(2 * phase) + 0.35 * Math.sin(3 * phase) + 0.2 * Math.sin(4 * phase));
    }
  });
  return mono(out);
}

/** Beatboxing: inharmonic transients, many attacks, no fundamental. */
function beatPattern(): MonoAudio {
  const total = Math.round(4 * RATE);
  const out = new Float32Array(total);
  let state = 12345;
  const noise = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state / 0x7fffffff) * 2 - 1;
  };

  const hits: Array<[number, 'kick' | 'snare' | 'hat']> = [];
  for (let bar = 0; bar < 4; bar += 1) {
    const t = bar;
    hits.push([t, 'kick'], [t + 0.25, 'hat'], [t + 0.5, 'snare'], [t + 0.75, 'hat']);
  }

  for (const [time, kind] of hits) {
    const start = Math.round(time * RATE);
    const decay = kind === 'kick' ? 0.12 : kind === 'snare' ? 0.09 : 0.03;
    const length = Math.round(decay * 4 * RATE);
    for (let i = 0; i < length && start + i < total; i += 1) {
      const t = i / RATE;
      const envelope = Math.exp(-t / decay);
      if (kind === 'kick') {
        const hz = 120 * Math.exp(-t * 22) + 45;
        out[start + i] = (out[start + i] as number) + 0.9 * envelope * Math.sin(2 * Math.PI * hz * t);
      } else {
        // Filtered noise: no periodicity at all.
        out[start + i] =
          (out[start + i] as number) + (kind === 'snare' ? 0.55 : 0.35) * envelope * noise();
      }
    }
  }
  return mono(out);
}

function mixedPhrase(): MonoAudio {
  const voice = sungPhrase();
  const beat = beatPattern();
  const out = new Float32Array(Math.max(voice.samples.length, beat.samples.length));
  for (let index = 0; index < out.length; index += 1) {
    out[index] =
      (voice.samples[index] ?? 0) * 0.75 +
      (beat.samples[index] ?? 0) * 0.55;
  }
  return mono(out);
}

describe('feature extraction', () => {
  it('finds a sung phrase highly voiced with long unbroken runs', () => {
    const features = extractIntentFeatures(sungPhrase());
    expect(features.voicedRatio).toBeGreaterThan(0.6);
    expect(features.meanVoicedRunSec).toBeGreaterThan(0.2);
  });

  it('finds a beat pattern barely voiced with frequent attacks', () => {
    const features = extractIntentFeatures(beatPattern());
    expect(features.voicedRatio).toBeLessThan(0.45);
    expect(features.onsetRate).toBeGreaterThan(1);
  });

  it('finds a pluck sharper in attack than a sung phrase', () => {
    expect(extractIntentFeatures(pluckedPhrase()).attackSharpness).toBeGreaterThan(
      extractIntentFeatures(sungPhrase()).attackSharpness,
    );
  });

  it('returns zeroed features for audio too short to analyse', () => {
    const features = extractIntentFeatures(mono(new Float32Array(256)));
    expect(features.voicedRatio).toBe(0);
    expect(features.onsetRate).toBe(0);
  });
});

describe('classification', () => {
  it('routes a sung phrase to voice', () => {
    const result = classifyIntent(sungPhrase());
    expect(result.intent).toBe('voice');
  });

  it('routes a beat pattern away from the melody engines', () => {
    // The important assertion is not "beat" but "not a pitch tracker": asking a
    // beatbox take for its fundamental is what produced nonsense before.
    const result = classifyIntent(beatPattern());
    expect(result.intent).toBe('beat');
    expect(result.scores.beat).toBeGreaterThan(result.scores.voice);
  });

  it('scores a pluck as more instrument-like than a sung phrase does', () => {
    const pluck = classifyIntent(pluckedPhrase());
    const sung = classifyIntent(sungPhrase());
    expect(pluck.scores.instrument).toBeGreaterThan(sung.scores.instrument);
  });

  it('always produces scores that sum to one', () => {
    for (const audio of [sungPhrase(), pluckedPhrase(), beatPattern()]) {
      const { scores } = classifyIntent(audio);
      expect(scores.voice + scores.instrument + scores.beat).toBeCloseTo(1, 6);
    }
  });

  it('asks the user rather than guessing on an ambiguous signal', () => {
    // Steady band-limited noise is genuinely none of the three.
    const samples = new Float32Array(RATE * 2);
    let state = 999;
    let previous = 0;
    for (let i = 0; i < samples.length; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const raw = (state / 0x7fffffff) * 2 - 1;
      previous = previous * 0.7 + raw * 0.3;
      samples[i] = previous * 0.3;
    }
    const result = classifyIntent(mono(samples));
    if (result.confidence < INTENT_ASK_THRESHOLD) expect(result.shouldAsk).toBe(true);
    // Whatever it decides, it must not claim near-certainty about noise.
    expect(result.confidence).toBeLessThan(0.95);
  });

  it('sets shouldAsk exactly when confidence is below the threshold', () => {
    for (const audio of [sungPhrase(), pluckedPhrase(), beatPattern()]) {
      const result = classifyIntent(audio);
      expect(result.shouldAsk).toBe(result.confidence < INTENT_ASK_THRESHOLD);
    }
  });

  it('is deterministic', () => {
    const audio = sungPhrase();
    expect(classifyIntent(audio)).toEqual(classifyIntent(audio));
  });

  it('reports the evidence alongside the answer', () => {
    // A misclassification has to be explainable, not just wrong.
    const result = classifyIntent(sungPhrase());
    expect(result.features.voicedRatio).toBeGreaterThan(0);
    expect(Object.keys(result.scores).sort()).toEqual(['beat', 'instrument', 'voice']);
  });
});

describe('internal InputClassifier routing contract', () => {
  it('routes continuous voice-shaped pitch through the melody path', () => {
    const result = classifyInput(sungPhrase());
    expect(result.type).toBe('melody');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning.length).toBeGreaterThan(1);
  });

  it('routes re-attacked pitched material through multipitch transcription', () => {
    expect(new InputClassifier().classify(pluckedPhrase()).type).toBe('polyphonic');
  });

  it('routes transient unpitched material through rhythm fidelity', () => {
    expect(classifyInput(beatPattern()).type).toBe('rhythm');
  });

  it('keeps simultaneous pitched and transient evidence as mixed', () => {
    expect(classifyInput(mixedPhrase()).type).toBe('mixed');
  });

  it('returns normalized scores for every internal route', () => {
    const scores = classifyInput(sungPhrase()).scores;
    expect(scores).toBeDefined();
    expect(Object.keys(scores ?? {}).sort()).toEqual(['melody', 'mixed', 'polyphonic', 'rhythm']);
    expect(Object.values(scores ?? {}).reduce((sum, score) => sum + score, 0)).toBeCloseTo(1, 6);
  });
});
