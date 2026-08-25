/**
 * The evaluation corpus registry.
 *
 * Two kinds of cases live here:
 *
 * **Synthesised** — generated with exact ground truth, graded on absolute
 * accuracy. These are the numbers that can be compared across commits, engines
 * and phases, because the reference is mathematically true.
 *
 * **Pinned real recordings** — owner recordings already trusted as regression
 * fixtures by the unit suite, graded on *behavioural* bounds (route decision,
 * note-count ranges) rather than accuracy, because their true content is known
 * to the performer, not to a file format. They catch real-world regressions
 * the synthetic corpus cannot see.
 *
 * Adding a case means adding a generator or a pin plus an entry here; the
 * runner, report and gate pick it up automatically.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MonoAudio } from '@contracts';
import type { PitchObservation, ReferenceNote } from '../metrics/pitch';
import {
  beatboxPattern,
  fingerTaps,
  glissando,
  harmonicHeavy,
  legatoScale,
  lowRegister,
  noisyRoom,
  octaveLeap,
  pluckedLine,
  quietWhisper,
  steadyHum,
  vibrato,
  type SynthCase,
} from './synthetic';

export interface CorpusCase {
  id: string;
  category: SynthCase['category'];
  description: string;
  audio: MonoAudio;
  expectedRoute?: 'melody' | 'polyphonic' | 'rhythm' | 'mixed';
  referenceNotes: ReferenceNote[];
  referenceFrames: PitchObservation[];
  referenceOnsets?: number[];
}

function synth(caseData: SynthCase): CorpusCase {
  return {
    id: caseData.id,
    category: caseData.category,
    description: caseData.description,
    audio: caseData.audio,
    expectedRoute: caseData.expectedRoute ?? undefined,
    referenceNotes: caseData.referenceNotes,
    referenceFrames: caseData.referenceFrames,
    referenceOnsets: caseData.referenceOnsets,
  };
}

/** Minimal RIFF reader for pinned fixture WAVs (16-bit PCM, any channel count). */
export function readPinnedWav(relativePath: string): MonoAudio {
  const bytes = readFileSync(join(process.cwd(), relativePath));
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
  if (channels < 1 || sampleRate <= 0 || dataLength <= 0) {
    throw new Error(`unsupported fixture WAV: ${relativePath}`);
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

export interface PinnedCase {
  id: string;
  category: 'real-pinned';
  description: string;
  wavPath: string;
  expectedRoute?: 'melody' | 'polyphonic' | 'rhythm' | 'mixed';
  /** Behavioural floor for the extraction output; tuned from measured baselines. */
  minNotes?: number;
  maxNotes?: number;
}

export const PINNED_CASES: readonly PinnedCase[] = [
  {
    id: 'real-mouth-test2',
    category: 'real-pinned',
    description: 'healthy mouth recording — melody route and a substantial transcription',
    wavPath: 'tests/fixtures/audio/mouth-test2.wav',
    expectedRoute: 'melody',
    minNotes: 15,
    maxNotes: 60,
  },
  {
    id: 'real-mouth-test3',
    category: 'real-pinned',
    description: 'consonant-articulated take that once misrouted to Basic Pitch',
    wavPath: 'tests/fixtures/audio/mouth-test3.wav',
    expectedRoute: 'melody',
    minNotes: 6,
    maxNotes: 80,
  },
  {
    id: 'real-test22',
    category: 'real-pinned',
    description: 'false-bass regression take with a clear F#4 transition',
    wavPath: 'tests/fixtures/audio/test22.wav',
    expectedRoute: 'melody',
    minNotes: 2,
    maxNotes: 40,
  },
  {
    id: 'real-recording-8',
    category: 'real-pinned',
    description: 'longer owner recording used by the melody regression suite',
    wavPath: 'tests/fixtures/audio/recording-8.wav',
    expectedRoute: 'melody',
    minNotes: 5,
    maxNotes: 120,
  },
];

export function synthesisedCases(): CorpusCase[] {
  return [
    steadyHum(),
    legatoScale(),
    vibrato(),
    glissando(),
    octaveLeap(),
    lowRegister(),
    quietWhisper(),
    noisyRoom(),
    harmonicHeavy(),
    beatboxPattern(),
    fingerTaps(),
    pluckedLine(),
  ].map(synth);
}
