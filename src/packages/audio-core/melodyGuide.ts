/**
 * A monophonic YIN guide for the polyphonic Basic Pitch decoder.
 *
 * Basic Pitch remains the candidate generator, but a hummed melody is a
 * single continuous voice. Running a lightweight 16 kHz YIN pass gives the
 * decoder an independent register and gives the selector an authority for
 * rejecting octave/sub-octave activations such as a sustained A2 underneath a
 * C4 melody.
 */

import type { MonoAudio, NoteEvent } from '@contracts';
import { peakNormalize, resample } from './normalize';
import {
  DEFAULT_SEGMENT_OPTIONS,
  DEFAULT_YIN_OPTIONS,
  hzToMidi,
  midiToHz,
  segmentNotes,
  trackPitch,
  type PitchFrame,
} from './pitch';

const GUIDE_SAMPLE_RATE = 16_000;
const GUIDE_HOP_SIZE = 256;
const REGISTER_MARGIN_SEMITONES = 3;
const MIN_REGISTER_FRAMES = 8;

export interface MelodyRegister {
  lowMidi: number;
  highMidi: number;
  centerMidi: number;
  minFrequencyHz: number;
  maxFrequencyHz: number;
}

export interface MelodyGuide {
  frames: PitchFrame[];
  notes: NoteEvent[];
  register: MelodyRegister | null;
}

export function buildMelodyGuide(audio: MonoAudio): MelodyGuide {
  const prepared = peakNormalize(resample(audio, GUIDE_SAMPLE_RATE));
  const frames = trackPitch(prepared.samples, prepared.sampleRate, {
    ...DEFAULT_YIN_OPTIONS,
    frameSize: 1024,
    hopSize: GUIDE_HOP_SIZE,
  });
  const notes = segmentNotes(
    frames,
    {
      ...DEFAULT_SEGMENT_OPTIONS,
      minDurationSec: 0.12,
    },
    GUIDE_HOP_SIZE / GUIDE_SAMPLE_RATE,
  );

  const voicedMidi = frames
    .filter(
      (frame) =>
        frame.frequencyHz > 0 &&
        frame.clarity >= DEFAULT_SEGMENT_OPTIONS.minClarity &&
        frame.rms >= DEFAULT_SEGMENT_OPTIONS.minRms,
    )
    .map((frame) => hzToMidi(frame.frequencyHz))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (voicedMidi.length < MIN_REGISTER_FRAMES) {
    return { frames, notes, register: null };
  }

  // Percentiles ignore a few octave flips at phrase boundaries. A three
  // semitone shoulder leaves vibrato and portamento room without admitting an
  // entire lower octave as a second voice.
  const low = percentile(voicedMidi, 0.08) - REGISTER_MARGIN_SEMITONES;
  const high = percentile(voicedMidi, 0.92) + REGISTER_MARGIN_SEMITONES;
  const center = percentile(voicedMidi, 0.5);
  const lowMidi = Math.max(24, Math.min(100, low));
  const highMidi = Math.max(lowMidi + 1, Math.min(108, high));

  return {
    frames,
    notes,
    register: {
      lowMidi,
      highMidi,
      centerMidi: center,
      minFrequencyHz: midiToHz(lowMidi),
      maxFrequencyHz: midiToHz(highMidi),
    },
  };
}

/**
 * Produces one note at a time. YIN supplies the segmentation/register; Basic
 * Pitch supplies pitch/velocity when a candidate agrees with that contour.
 */
export function guideMelodyCandidates(
  candidates: readonly NoteEvent[],
  guide: MelodyGuide,
): NoteEvent[] {
  if (guide.notes.length === 0) return monophonizeCandidates(candidates);

  const selected: NoteEvent[] = [];
  let previousPitch: number | null = null;

  for (const reference of guide.notes) {
    const referenceDuration = Math.max(0.001, reference.endSec - reference.startSec);
    let best: { note: NoteEvent; score: number } | null = null;

    for (const candidate of candidates) {
      const overlap = overlapSeconds(reference, candidate);
      if (overlap <= 0) continue;
      const distance = Math.abs(candidate.pitch - reference.pitch);
      // A candidate an octave away is exactly the failure this layer exists to
      // reject. Small disagreements remain eligible for expressive slides.
      if (distance > 2.5) continue;
      const overlapRatio = overlap / referenceDuration;
      const continuityPenalty: number =
        previousPitch === null ? 0 : Math.max(0, Math.abs(candidate.pitch - previousPitch) - 7) * 0.08;
      const score: number =
        overlapRatio * 2 + (candidate.confidence ?? candidate.velocity / 127) - distance * 0.4 - continuityPenalty;
      if (best === null || score > best.score) best = { note: candidate, score };
    }

    const chosenPitch: number = best?.note.pitch ?? reference.pitch;
    const note: NoteEvent = {
      startSec: reference.startSec,
      endSec: reference.endSec,
      pitch: chosenPitch,
      velocity: best?.note.velocity ?? reference.velocity,
      confidence: Math.max(reference.confidence ?? 0, best?.note.confidence ?? 0),
    };
    selected.push(note);
    previousPitch = chosenPitch;
  }

  return mergeAdjacent(selected);
}

export function notesAreMonophonic(notes: readonly NoteEvent[]): boolean {
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  let latestEnd = 0;
  for (const note of sorted) {
    if (note.startSec < latestEnd - 1e-6) return false;
    latestEnd = Math.max(latestEnd, note.endSec);
  }
  return true;
}

function monophonizeCandidates(candidates: readonly NoteEvent[]): NoteEvent[] {
  const ranked = [...candidates].sort((a, b) => {
    const aScore = (a.confidence ?? a.velocity / 127) * Math.max(0.01, a.endSec - a.startSec);
    const bScore = (b.confidence ?? b.velocity / 127) * Math.max(0.01, b.endSec - b.startSec);
    return bScore - aScore || a.startSec - b.startSec;
  });
  const kept: NoteEvent[] = [];
  for (const candidate of ranked) {
    if (kept.every((note) => overlapSeconds(note, candidate) <= 0)) kept.push({ ...candidate });
  }
  return kept.sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
}

function mergeAdjacent(notes: readonly NoteEvent[]): NoteEvent[] {
  const merged: NoteEvent[] = [];
  for (const note of notes) {
    const previous = merged.at(-1);
    if (previous && previous.pitch === note.pitch && note.startSec - previous.endSec <= 0.05) {
      previous.endSec = Math.max(previous.endSec, note.endSec);
      previous.velocity = Math.max(previous.velocity, note.velocity);
      previous.confidence = Math.max(previous.confidence ?? 0, note.confidence ?? 0);
    } else {
      merged.push({ ...note });
    }
  }
  return merged;
}

function overlapSeconds(a: NoteEvent, b: NoteEvent): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const amount = position - low;
  const left = sorted[low] as number;
  const right = sorted[high] as number;
  return left + (right - left) * amount;
}
