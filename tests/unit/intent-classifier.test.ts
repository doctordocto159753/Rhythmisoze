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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MonoAudio } from '@contracts';
import {
  InputClassifier,
  classifyInput,
  classifyIntent,
  correctClassification,
  extractIntentFeatures,
  INTENT_ASK_THRESHOLD,
  reconcileClassificationWithMaterial,
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

function ambiguousNoise(): MonoAudio {
  const samples = new Float32Array(RATE * 2);
  let state = 999;
  let previous = 0;
  for (let index = 0; index < samples.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const raw = (state / 0x7fffffff) * 2 - 1;
    previous = previous * 0.7 + raw * 0.3;
    samples[index] = previous * 0.3;
  }
  return mono(samples);
}

/**
 * A lyric-like line whose vowel islands are short even though the phrase is
 * continuous. The low-passed consonant bed keeps energy connected without
 * pretending every frame has a single fundamental.
 */
function syllabicVocalPhrase(): MonoAudio {
  const totalSec = 4;
  const samples = new Float32Array(Math.round(totalSec * RATE));
  let phase = 0;
  let noiseState = 2468;
  let breath = 0;
  const pitches = [196, 220, 246.94, 261.63, 293.66, 261.63, 246.94, 220];

  for (let index = 0; index < samples.length; index += 1) {
    const time = index / RATE;
    const phraseTime = time < 2 ? time : time - 2.15;
    if (time >= 2 && time < 2.15) continue;

    const note = pitches[Math.min(pitches.length - 1, Math.floor(time / 0.5))] as number;
    phase += (2 * Math.PI * note) / RATE;
    const cycle = ((phraseTime % 0.12) + 0.12) % 0.12;
    const tonal = cycle < 0.072;
    noiseState = (noiseState * 1103515245 + 12345) & 0x7fffffff;
    const rawNoise = (noiseState / 0x7fffffff) * 2 - 1;
    breath = breath * 0.94 + rawNoise * 0.06;

    const source = tonal
      ? Math.sin(phase) + 0.25 * Math.sin(2 * phase)
      : breath * 7;
    const stressedSyllable = (time >= 1 && time < 1.25) || (time >= 3 && time < 3.25);
    samples[index] = (stressedSyllable ? 0.45 : 0.2) * source;
  }
  return mono(samples);
}

function scaled(audio: MonoAudio, gain: number): MonoAudio {
  const samples = Float32Array.from(audio.samples, (sample) => sample * gain);
  return { ...audio, samples };
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
    const result = classifyIntent(ambiguousNoise());
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

  it('keeps a syllabic vocal phrase on the melody route despite short voiced runs', () => {
    const audio = syllabicVocalPhrase();
    const features = extractIntentFeatures(audio);
    expect(features.meanVoicedRunSec).toBeLessThan(0.1);
    expect(classifyInput(audio).type).toBe('melody');
  });

  it('classifies a faint valid performance from the same evidence as its full-level source', () => {
    const source = pluckedPhrase();
    const quiet = scaled(source, 0.025);
    expect(classifyInput(quiet).type).toBe('polyphonic');
    expect(classifyInput(quiet).type).toBe(classifyInput(source).type);
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

  it('abstains on noise instead of forcing a melody route', () => {
    const result = classifyInput(ambiguousNoise());
    expect(result.type).toBe('unknown');
    expect(result.confidence).toBeLessThan(INTENT_ASK_THRESHOLD);
    expect(result.reasoning.join(' ')).toMatch(/enough musical evidence/i);
  });

  it('returns normalized scores for every internal route', () => {
    const scores = classifyInput(sungPhrase()).scores;
    expect(scores).toBeDefined();
    expect(Object.keys(scores ?? {}).sort()).toEqual([
      'melody',
      'mixed',
      'polyphonic',
      'rhythm',
      'unknown',
    ]);
    expect(Object.values(scores ?? {}).reduce((sum, score) => sum + score, 0)).toBeCloseTo(1, 6);
  });

  it('records a post-review correction without erasing automatic evidence', () => {
    const automatic = classifyInput(beatPattern());
    const corrected = correctClassification(automatic, 'melody');
    expect(corrected.type).toBe('melody');
    expect(corrected.method).toBe('user-corrected');
    expect(corrected.originalType).toBe('rhythm');
    expect(corrected.features).toEqual(automatic.features);
    expect(corrected.reasoning.at(-1)).toBe('user_corrected_route=melody');
  });

  it('presents rhythm when a mixed pitch branch has no survivors', () => {
    const mixed = classifyInput(mixedPhrase());
    const reconciled = reconcileClassificationWithMaterial(mixed, 0, 12);
    expect(reconciled.type).toBe('rhythm');
    expect(reconciled.reasoning.at(-1)).toMatch(/pitch_branch_empty/);
  });
});

describe('mouth-melody routing guard', () => {
  const MOUTH_FIXTURES = join(process.cwd(), 'tests/fixtures/audio');

  /**
   * Real recordings, pinned for the same reason Recording (8) and test22 are:
   * synthesised vowels cannot reproduce what consonant articulation does to
   * attack statistics. Both of these are mouth-recorded melodies whose
   * consonants ("da-ba-li-da"-style syllables) pushed the pre-guard classifier
   * into the multipitch route, which scattered them across registers.
   */
  function mouthFixture(name: string): MonoAudio {
    const bytes = readFileSync(join(MOUTH_FIXTURES, `${name}.wav`));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let channels = 0;
    let sampleRate = 0;
    let dataOffset = 0;
    let dataLength = 0;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString('ascii', offset, offset + 4);
      const length = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === 'fmt ') {
        channels = view.getUint16(body + 2, true);
        sampleRate = view.getUint32(body + 4, true);
      } else if (id === 'data') {
        dataOffset = body;
        dataLength = length;
        break;
      }
      offset = body + length + (length % 2);
    }
    const frameCount = Math.floor(dataLength / (channels * 2));
    const samples = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      samples[frame] = view.getInt16(dataOffset + frame * channels * 2, true) / 32768;
    }
    return { samples, sampleRate, durationSec: frameCount / sampleRate };
  }

  it('keeps a consonant-articulated mouth recording on the melody route', () => {
    const result = classifyInput(mouthFixture('mouth-test3'));
    expect(result.type).toBe('melody');
    // The guard, not an accident of scoring, is what holds the route.
    expect(result.reasoning.join(' ')).toMatch(/mouth_melody_guard/);
  });

  it('holds a clean mouth recording on the melody route without losing confidence', () => {
    const result = classifyInput(mouthFixture('mouth-test2'));
    expect(result.type).toBe('melody');
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('does not give plucked instruments the guard treatment', () => {
    // The guard may only fire when attacks stay soft. A real re-attacked
    // phrase must still reach multipitch transcription.
    const result = classifyInput(pluckedPhrase());
    expect(result.type).toBe('polyphonic');
    expect(result.reasoning.join(' ')).not.toMatch(/mouth_melody_guard/);
  });

  it('does not fire when percussion is a competing lead', () => {
    // Voice plus drums is a layered take, not a solo melody: it keeps both.
    const result = classifyInput(mixedPhrase());
    expect(result.type).toBe('mixed');
    expect(result.reasoning.join(' ')).not.toMatch(/mouth_melody_guard/);
  });

  it('leaves transient material on the rhythm route', () => {
    expect(classifyInput(beatPattern()).type).toBe('rhythm');
  });
});
