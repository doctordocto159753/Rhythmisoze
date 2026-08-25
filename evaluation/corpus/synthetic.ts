/**
 * Deterministic synthesised corpus.
 *
 * Ground truth you can trust has to come from audio whose contents are known
 * exactly, which means it is generated, not recorded. Every generator here is
 * a pure function of its parameters — the only randomness is a seeded linear
 * congruential stream, so two runs on any machine produce bit-identical audio
 * and identical metric numbers.
 *
 * The synthesis is deliberately naive. These are not convincing voices; they
 * are *musically specified* signals: harmonic series with known f0 paths,
 * known envelopes, known hit times. That is the point — each case isolates one
 * behaviour the pipeline must handle (a held note, a glide, an octave leap, a
 * whisper level) and grades exactly that behaviour.
 */

import type { MonoAudio } from '@contracts';
import type { PitchObservation, ReferenceNote } from '../metrics/pitch';

export const SYNTH_RATE = 16_000;

/** Seeded uniform noise in [−1, 1). Reproducible on every platform. */
export class SeededNoise {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    this.state = (this.state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return ((this.state / 0x7fff_ffff) * 2 - 1);
  }
}

/** Additive harmonic tone with partial amplitudes; phase-continuous within a note. */
function renderTone(
  out: Float32Array,
  rate: number,
  startSec: number,
  durationSec: number,
  hzAt: (tSec: number) => number,
  partials: readonly number[],
  amplitudeAt: (tSec: number) => number,
): void {
  const start = Math.round(startSec * rate);
  const length = Math.round(durationSec * rate);
  let phase = 0;
  for (let index = 0; index < length && start + index < out.length; index += 1) {
    const t = index / rate;
    phase += (2 * Math.PI * hzAt(t)) / rate;
    let sample = 0;
    for (let partial = 0; partial < partials.length; partial += 1) {
      sample += (partials[partial] as number) * Math.sin((partial + 1) * phase);
    }
    out[start + index] = (out[start + index] ?? 0) + amplitudeAt(t) * sample;
  }
}

export interface SynthCase {
  id: string;
  category: 'voice-melody' | 'difficult' | 'rhythm' | 'instrument';
  /** What the route decision should be, when the case tests routing at all. */
  expectedRoute?: 'melody' | 'polyphonic' | 'rhythm' | 'mixed' | null;
  audio: MonoAudio;
  referenceNotes: ReferenceNote[];
  referenceFrames: PitchObservation[];
  /** Exact onset times for rhythm cases. */
  referenceOnsets?: number[];
  description: string;
}

const FRAME_SEC = 0.01;

/** Builds the reference frame grid from a per-frame midi-or-null function. */
function framesFrom(
  totalSec: number,
  midiAt: (timeSec: number) => number | null,
): PitchObservation[] {
  const frames: PitchObservation[] = [];
  for (let time = 0; time < totalSec - FRAME_SEC / 2; time += FRAME_SEC) {
    frames.push({ timeSec: Number(time.toFixed(3)), midi: midiAt(time) });
  }
  return frames;
}

function notesFromSpans(spans: ReadonlyArray<{ start: number; end: number; midi: number }>): ReferenceNote[] {
  return spans.map((span) => ({ startSec: span.start, endSec: span.end, midi: span.midi }));
}

interface ToneSpan {
  start: number;
  end: number;
  fromMidi: number;
  toMidi?: number;
  attackSec?: number;
  releaseSec?: number;
  partials?: readonly number[];
}

const DEFAULT_PARTIALS = [1, 0.4, 0.18];

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Renders a sequence of tone spans with soft envelopes and returns both the
 * audio and its exact reference (notes + frame grid). Glides interpolate
 * pitch across the whole span when `toMidi` differs.
 */
function renderVoicePhrase(
  id: string,
  spans: readonly ToneSpan[],
  options: { amplitude?: number; breathNoise?: number; seed?: number; tailSec?: number } = {},
): { audio: MonoAudio; referenceNotes: ReferenceNote[]; referenceFrames: PitchObservation[] } {
  const totalSec =
    spans.reduce((latest, span) => Math.max(latest, span.end), 0) + (options.tailSec ?? 0.15);
  const samples = new Float32Array(Math.ceil(totalSec * SYNTH_RATE));
  const noise = new SeededNoise(options.seed ?? 20_260_826);
  const breath = options.breathNoise ?? 0;
  let breathState = 0;

  for (let index = 0; index < samples.length; index += 1) {
    if (breath > 0) {
      breathState = breathState * 0.94 + noise.next() * 0.06;
      samples[index] = (samples[index] ?? 0) + breathState * breath;
    }
  }

  const referenceNotes = notesFromSpans(
    spans.map((span) => ({ start: span.start, end: span.end, midi: span.toMidi ?? span.fromMidi })),
  );

  for (const span of spans) {
    const attack = span.attackSec ?? 0.03;
    const release = span.releaseSec ?? 0.06;
    const duration = span.end - span.start;
    const glideTo = span.toMidi !== undefined && span.toMidi !== span.fromMidi;
    // A glissando interpolates continuously; a stable note holds. The
    // transition zone is the middle of the span so both endpoints keep clean
    // steady regions the tracker can lock onto.
    renderTone(samples, SYNTH_RATE, span.start, duration, (t) => {
      const progress = t / duration;
      const midi = glideTo
        ? span.fromMidi + ((span.toMidi as number) - span.fromMidi) * progress
        : span.fromMidi;
      return midiToHz(midi);
    }, span.partials ?? DEFAULT_PARTIALS, (t) => {
      if (t < attack) return t / attack;
      if (t > duration - release) return Math.max(0, (duration - t) / release);
      return 1;
    });
  }

  const referenceFrames = framesFrom(totalSec, (time) => {
    for (const span of spans) {
      if (time >= span.start && time < span.end) {
        // A glide's ground truth interpolates exactly like the rendered tone;
        // a stable note holds. This keeps the frame-level reference honest
        // for portamento instead of grading against a destination pitch.
        if (span.toMidi !== undefined && span.toMidi !== span.fromMidi) {
          const progress = (time - span.start) / (span.end - span.start);
          return span.fromMidi + (span.toMidi - span.fromMidi) * progress;
        }
        return span.fromMidi;
      }
    }
    return null;
  });

  return {
    audio: { samples, sampleRate: SYNTH_RATE, durationSec: totalSec },
    referenceNotes,
    referenceFrames,
  };
}

export function steadyHum(): SynthCase {
  const phrase = renderVoicePhrase('steady-hum', [
    { start: 0.2, end: 2.2, fromMidi: 60 },
  ]);
  return {
    id: 'voice-steady-hum',
    category: 'voice-melody',
    description: 'one held C4 — the simplest thing the voice engine must survive',
    ...phrase,
  };
}

export function legatoScale(): SynthCase {
  const pitches = [57, 59, 60, 62, 64];
  const spans: ToneSpan[] = pitches.map((midi, index) => ({
    start: 0.2 + index * 0.58,
    end: 0.2 + index * 0.58 + 0.5,
    fromMidi: midi,
  }));
  return {
    id: 'voice-scale-legato',
    category: 'voice-melody',
    description: 'five-note rising scale with small gaps — segmentation must find five notes',
    ...renderVoicePhrase('scale', spans),
  };
}

export function octaveLeap(): SynthCase {
  const spans: ToneSpan[] = [
    { start: 0.2, end: 0.8, fromMidi: 60 },
    { start: 0.9, end: 1.5, fromMidi: 72 },
    { start: 1.6, end: 2.2, fromMidi: 60 },
  ];
  return {
    id: 'diff-octave-leap',
    category: 'difficult',
    description: 'C4 → C5 → C4: real register jumps that no stage may fold away',
    ...renderVoicePhrase('leap', spans),
  };
}

export function vibrato(): SynthCase {
  const centreHz = midiToHz(64);
  const spans: ToneSpan[] = [{ start: 0.2, end: 2.4, fromMidi: 64 }];
  const phrase = renderVoicePhrase('vibrato', spans);
  // Overwrite with true vibrato around E4; the reference stays the centre.
  const { audio } = phrase;
  const start = Math.round(0.2 * SYNTH_RATE);
  const length = Math.round(2.2 * SYNTH_RATE);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const t = index / SYNTH_RATE;
    const hz = centreHz * (1 + 0.02 * Math.sin(2 * Math.PI * 5.5 * t));
    phase += (2 * Math.PI * hz) / SYNTH_RATE;
    audio.samples[start + index] =
      0.8 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.18 * Math.sin(3 * phase));
  }
  return {
    id: 'voice-vibrato',
    category: 'voice-melody',
    description: 'E4 with ±35-cent 5.5 Hz vibrato — one note, not many',
    ...phrase,
  };
}

export function glissando(): SynthCase {
  const spans: ToneSpan[] = [{ start: 0.2, end: 1.7, fromMidi: 55, toMidi: 62 }];
  return {
    id: 'voice-glissando',
    category: 'voice-melody',
    description: 'G3→D4 continuous glide — continuity must survive without fragmenting',
    ...renderVoicePhrase('glide', spans),
  };
}

export function lowRegister(): SynthCase {
  const spans: ToneSpan[] = [
    { start: 0.2, end: 0.7, fromMidi: 40 },
    { start: 0.8, end: 1.3, fromMidi: 43 },
    { start: 1.4, end: 1.9, fromMidi: 45 },
  ];
  return {
    id: 'diff-low-register',
    category: 'difficult',
    description: 'E2–A2 phrase near the tracker floor',
    ...renderVoicePhrase('low', spans, { amplitude: 0.9 }),
  };
}

export function quietWhisper(): SynthCase {
  const phrase = renderVoicePhrase('whisper', [
    { start: 0.2, end: 0.7, fromMidi: 62 },
    { start: 0.8, end: 1.3, fromMidi: 65 },
    { start: 1.4, end: 1.9, fromMidi: 67 },
  ], { amplitude: 0.02, breathNoise: 0.004 });
  return {
    id: 'diff-quiet-whisper',
    category: 'difficult',
    description: 'three-note phrase at −34 dBFS with breath noise — capture-floor behaviour',
    ...phrase,
  };
}

export function noisyRoom(): SynthCase {
  const phrase = renderVoicePhrase('noisy', [
    { start: 0.2, end: 0.7, fromMidi: 60 },
    { start: 0.8, end: 1.3, fromMidi: 63 },
    { start: 1.4, end: 1.9, fromMidi: 65 },
  ]);
  // Broadband room noise roughly 15 dB under the tone peaks: audible, but the
  // melody must still be the loudest periodic thing present.
  const noise = new SeededNoise(777);
  let lowPassed = 0;
  for (let index = 0; index < phrase.audio.samples.length; index += 1) {
    lowPassed = lowPassed * 0.85 + noise.next() * 0.15;
    phrase.audio.samples[index] = (phrase.audio.samples[index] ?? 0) + lowPassed * 0.05;
  }
  return {
    id: 'diff-noisy-room',
    category: 'difficult',
    description: 'three-note phrase under broadband room noise',
    ...phrase,
  };
}

export function harmonicHeavy(): SynthCase {
  const spans: ToneSpan[] = [
    { start: 0.2, end: 0.8, fromMidi: 57, partials: [1, 0.95, 0.85, 0.7] },
    { start: 0.9, end: 1.5, fromMidi: 60, partials: [1, 0.95, 0.85, 0.7] },
    { start: 1.6, end: 2.2, fromMidi: 64, partials: [1, 0.95, 0.85, 0.7] },
  ];
  return {
    id: 'diff-harmonic-heavy',
    category: 'difficult',
    description: 'bright tone with strong upper partials — probes harmonic/octave confusion',
    ...renderVoicePhrase('harmonic', spans),
  };
}

/** Rhythmic material is synthesised at the classification-native rate. */
export const RHYTHM_RATE = 44_100;

export function beatboxPattern(): SynthCase {
  const totalSec = 3;
  const samples = new Float32Array(totalSec * RHYTHM_RATE);
  const noise = new SeededNoise(4242);
  const onsets: number[] = [];
  const pattern: Array<{ at: number; kind: 'kick' | 'snare' | 'hat' }> = [];
  for (let bar = 0; bar < 3; bar += 1) {
    pattern.push(
      { at: bar, kind: 'kick' },
      { at: bar + 0.5, kind: 'snare' },
      { at: bar + 0.75, kind: 'hat' },
      { at: bar + 1.25, kind: 'hat' },
      { at: bar + 1.5, kind: 'kick' },
      { at: bar + 1.75, kind: 'snare' },
    );
  }
  for (const hit of pattern) {
    const start = Math.round(hit.at * RHYTHM_RATE);
    onsets.push(hit.at);
    const decay = hit.kind === 'kick' ? 0.11 : hit.kind === 'snare' ? 0.08 : 0.03;
    const length = Math.round(decay * RHYTHM_RATE);
    for (let index = 0; index < length && start + index < samples.length; index += 1) {
      const t = index / RHYTHM_RATE;
      const envelope = Math.exp(-t / decay);
      if (hit.kind === 'kick') {
        const hz = 110 * Math.exp(-t * 24) + 46;
        samples[start + index] = (samples[start + index] ?? 0) + 0.85 * envelope * Math.sin(2 * Math.PI * hz * t);
      } else {
        samples[start + index] =
          (samples[start + index] ?? 0) + (hit.kind === 'snare' ? 0.5 : 0.3) * envelope * noise.next();
      }
    }
  }
  return {
    id: 'rhythm-beatbox-pattern',
    category: 'rhythm',
    expectedRoute: 'rhythm',
    audio: { samples, sampleRate: RHYTHM_RATE, durationSec: totalSec },
    referenceNotes: [],
    referenceFrames: [],
    referenceOnsets: onsets.sort((a, b) => a - b),
    description: 'kick/snare/hat loop — routing plus onset placement',
  };
}

export function fingerTaps(): SynthCase {
  const count = 10;
  const spacing = 0.42;
  const totalSec = count * spacing + 0.3;
  const samples = new Float32Array(Math.ceil(totalSec * RHYTHM_RATE));
  const noise = new SeededNoise(99);
  const onsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 0.25 + index * spacing;
    onsets.push(at);
    const start = Math.round(at * RHYTHM_RATE);
    const length = Math.round(0.04 * RHYTHM_RATE);
    for (let sample = 0; sample < length && start + sample < samples.length; sample += 1) {
      const t = sample / RHYTHM_RATE;
      samples[start + sample] =
        (samples[start + sample] ?? 0) +
        (0.55 * Math.exp(-t / 0.008) + 0.25 * Math.exp(-t / 0.025)) * noise.next();
    }
  }
  return {
    id: 'rhythm-finger-taps',
    category: 'rhythm',
    expectedRoute: 'rhythm',
    audio: { samples, sampleRate: RHYTHM_RATE, durationSec: totalSec },
    referenceNotes: [],
    referenceFrames: [],
    referenceOnsets: onsets,
    description: 'ten evenly spaced taps — pure pulse detection',
  };
}

export function pluckedLine(): SynthCase {
  const notes = [196, 246.94, 293.66, 246.94, 196];
  const noteSec = 0.45;
  const total = notes.length * noteSec + 0.2;
  const samples = new Float32Array(Math.ceil(total * RHYTHM_RATE));
  notes.forEach((hz, index) => {
    const start = Math.round((0.15 + index * noteSec) * RHYTHM_RATE);
    for (let i = 0; i < Math.round(noteSec * RHYTHM_RATE) && start + i < samples.length; i += 1) {
      const t = i / RHYTHM_RATE;
      const envelope = Math.exp(-t * 6) * (t < 0.002 ? t / 0.002 : 1);
      const phase = 2 * Math.PI * hz * t;
      samples[start + i] =
        (samples[start + i] ?? 0) +
        0.5 * envelope *
        (Math.sin(phase) + 0.55 * Math.sin(2 * phase) + 0.35 * Math.sin(3 * phase));
    }
  });
  return {
    id: 'instrument-plucked-line',
    category: 'instrument',
    expectedRoute: 'polyphonic',
    audio: { samples, sampleRate: RHYTHM_RATE, durationSec: total },
    referenceNotes: [],
    referenceFrames: [],
    description: 'decaying plucks — must reach the multipitch route, not the voice tracker',
  };
}
