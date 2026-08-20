import { readFileSync } from 'node:fs';
import type { MonoAudio } from '@contracts';

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
