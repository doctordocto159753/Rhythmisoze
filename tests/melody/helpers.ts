import { readFileSync } from 'node:fs';
import type { MonoAudio } from '@contracts';
import { midiToFrequency, type PitchFrame } from '@/packages/melody-extraction';

/**
 * A contour frame, for tests that want to drive one stage directly.
 *
 * `PitchFrame` carries the tracker's provisional evidence alongside its
 * accepted reading, and a test that only cares about the accepted pitch should
 * not have to restate the rest. Omitting `midiPitch` makes an unvoiced frame
 * that still carries a candidate, which is the interesting case for bridging.
 */
export function frameAt(
  timeSec: number,
  midiPitch: number | null,
  options: { confidence?: number; clarity?: number; rms?: number; candidateMidi?: number | null } = {},
): PitchFrame {
  const confidence = options.confidence ?? 0.9;
  const candidateMidi = options.candidateMidi === undefined ? midiPitch : options.candidateMidi;
  return {
    timeSec,
    frequencyHz: midiPitch === null ? null : midiToFrequency(midiPitch),
    midiPitch,
    candidateHz: candidateMidi === null ? null : midiToFrequency(candidateMidi),
    candidateMidi,
    clarity: options.clarity ?? confidence,
    confidence,
    rms: options.rms ?? 0.2,
    voiced: midiPitch !== null,
  };
}

export function readPcm16Wav(path: string): MonoAudio {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a RIFF/WAVE fixture: ${path}`);
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let format = 0;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = length;
      break;
    }
    offset = body + length + (length % 2);
  }
  if (format !== 1 || channels < 1 || sampleRate <= 0 || bitsPerSample !== 16 || dataLength <= 0) {
    throw new Error(`Unsupported WAV fixture format: ${path}`);
  }
  const frameCount = Math.floor(dataLength / (channels * 2));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate, durationSec: frameCount / sampleRate };
}

export function synthesizeMelody(
  pitches: readonly number[],
  options: { noteSec?: number; gapSec?: number; vibratoSemitones?: number } = {},
): { audio: MonoAudio; labels: Array<{ startSec: number; endSec: number; pitch: number }> } {
  const sampleRate = 16_000;
  const noteSec = options.noteSec ?? 0.45;
  const gapSec = options.gapSec ?? 0.07;
  const leadSec = 0.15;
  const durationSec = leadSec + pitches.length * (noteSec + gapSec) + 0.15;
  const samples = new Float32Array(Math.ceil(durationSec * sampleRate));
  const labels: Array<{ startSec: number; endSec: number; pitch: number }> = [];
  pitches.forEach((pitch, noteIndex) => {
    const startSec = leadSec + noteIndex * (noteSec + gapSec);
    const endSec = startSec + noteSec;
    labels.push({ startSec, endSec, pitch });
    let phase = 0;
    for (let index = Math.floor(startSec * sampleRate); index < Math.floor(endSec * sampleRate); index += 1) {
      const localSec = index / sampleRate - startSec;
      const edge = Math.min(1, localSec / 0.025, (endSec - index / sampleRate) / 0.025);
      const vibrato = (options.vibratoSemitones ?? 0) * Math.sin(2 * Math.PI * 5.2 * localSec);
      const frequency = 440 * 2 ** ((pitch + vibrato - 69) / 12);
      phase += (2 * Math.PI * frequency) / sampleRate;
      samples[index] = edge * (0.55 * Math.sin(phase) + 0.12 * Math.sin(phase * 2));
    }
  });
  return { audio: { samples, sampleRate, durationSec }, labels };
}

/**
 * A voice-like tone described as a pitch-and-amplitude curve over time.
 *
 * The existing `synthesizeMelody` makes clean, evenly-spaced notes, which is
 * the one thing real humming never is. These fixtures need the awkward cases:
 * a note whose level dips to a whisper in the middle, a phrase that slides
 * between two pitches, an attack that arrives breathy before it settles.
 *
 * `pitchAt` returns MIDI (fractional is fine) or `null` for silence; `gainAt`
 * returns 0..1. Both are sampled per output sample, so a curve can be as
 * detailed as it likes. `breathiness` mixes in shaped noise, which is what
 * actually drives YIN's clarity down — the thing the old voicing gate could not
 * tell apart from the note ending.
 */
export function synthesizeVoice(options: {
  durationSec: number;
  pitchAt: (timeSec: number) => number | null;
  gainAt?: (timeSec: number) => number;
  breathiness?: number;
  sampleRate?: number;
}): MonoAudio {
  const sampleRate = options.sampleRate ?? 16_000;
  const length = Math.ceil(options.durationSec * sampleRate);
  const samples = new Float32Array(length);
  const breath = options.breathiness ?? 0.02;
  let phase = 0;
  // Deterministic noise, so a failure is reproducible.
  let state = 0x2545f491;
  const noise = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state / 0x7fffffff) % 1;
  };

  for (let index = 0; index < length; index += 1) {
    const timeSec = index / sampleRate;
    const midi = options.pitchAt(timeSec);
    const gain = options.gainAt ? options.gainAt(timeSec) : 1;
    if (midi === null || gain <= 0) {
      // Room tone, not digital silence: a real recording never has none.
      samples[index] = noise() * 0.0015;
      continue;
    }
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    phase += (2 * Math.PI * frequency) / sampleRate;
    // Two partials plus a third: enough harmonic structure for YIN to lock on
    // without being a pure sine, which is unrealistically easy.
    const tone =
      0.55 * Math.sin(phase) + 0.18 * Math.sin(phase * 2) + 0.07 * Math.sin(phase * 3);
    samples[index] = gain * (tone + noise() * breath);
  }
  return { samples, sampleRate, durationSec: length / sampleRate };
}

/** A cosine ramp, so a level change has no click in it. */
export function ramp(value: number, from: number, to: number): number {
  if (value <= from) return 0;
  if (value >= to) return 1;
  return 0.5 - 0.5 * Math.cos((Math.PI * (value - from)) / (to - from));
}
