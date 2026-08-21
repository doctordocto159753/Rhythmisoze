import type { MelodyConfidence, MonoAudio, NoteEvent } from '@contracts';
import { smoothPitchContour, type VocalRange } from './contour';
import { generateMelodyNoteEvents } from './midi-generator';
import {
  DEFAULT_PITCH_TRACKER_OPTIONS,
  trackFundamentalPitch,
  type PitchFrame,
  type PitchTrackerOptions,
} from './pitch-tracker';
import { calculateMelodyConfidence } from './quality';
import {
  segmentPitchContour,
  type MelodySegment,
  type SegmentationOptions,
} from './segmentation';

export interface MelodyExtractionOptions {
  pitchTracker?: Partial<PitchTrackerOptions>;
  segmentation?: Partial<SegmentationOptions>;
}

export interface MelodyExtractionResult {
  frames: PitchFrame[];
  range: VocalRange | null;
  segments: MelodySegment[];
  notes: NoteEvent[];
  quality: MelodyConfidence;
}

/** Complete local Human Voice Melody Extraction pipeline. */
export function extractHumanMelody(
  audio: MonoAudio,
  options: MelodyExtractionOptions = {},
): MelodyExtractionResult {
  const tracked = trackFundamentalPitch(audio.samples, audio.sampleRate, {
    ...DEFAULT_PITCH_TRACKER_OPTIONS,
    ...options.pitchTracker,
  });
  const contour = smoothPitchContour(tracked);
  const segments = segmentPitchContour(contour.frames, {
    // The register the contour established, so an octave repair at the segment
    // level cannot place a note outside the range this person actually sang in.
    register: contour.range
      ? { lowMidi: contour.range.lowMidi, highMidi: contour.range.highMidi }
      : null,
    ...options.segmentation,
  });
  const notes = generateMelodyNoteEvents(segments);
  return {
    frames: contour.frames,
    range: contour.range,
    segments,
    notes,
    quality: calculateMelodyConfidence(contour.frames, notes, contour.range),
  };
}

export * from './pitch-tracker';
export * from './contour';
export * from './segmentation';
export * from './midi-generator';
export * from './quality';
export * from './diagnostics';
