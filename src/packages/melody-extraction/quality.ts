import type { MelodyConfidence, NoteEvent } from '@contracts';
import type { VocalRange } from './contour';
import type { PitchFrame } from './pitch-tracker';

export const MELODY_CONFIDENCE_THRESHOLD = 0.55;

export function calculateMelodyConfidence(
  frames: readonly PitchFrame[],
  notes: readonly NoteEvent[],
  range: VocalRange | null,
): MelodyConfidence {
  if (frames.length === 0) return emptyAssessment();
  const voiced = frames.filter((frame) => frame.midiPitch !== null);
  const voicedFramePercentage = voiced.length / frames.length;

  let continuityComparisons = 0;
  let continuous = 0;
  let octaveComparisons = 0;
  let octaveStable = 0;
  let previous: PitchFrame | null = null;
  for (const frame of voiced) {
    if (previous) {
      const gap = frame.timeSec - previous.timeSec;
      if (gap <= 0.08) {
        const jump = Math.abs((frame.midiPitch as number) - (previous.midiPitch as number));
        continuityComparisons += 1;
        if (jump <= 2.5) continuous += 1;
        octaveComparisons += 1;
        if (jump <= 6) octaveStable += 1;
      }
    }
    previous = frame;
  }
  const pitchContinuity = continuityComparisons > 0 ? continuous / continuityComparisons : 0;
  const octaveStability = octaveComparisons > 0 ? octaveStable / octaveComparisons : 0;
  const segmentationConfidence = notes.length > 0
    ? notes.reduce((sum, note) => sum + (note.confidence ?? 0), 0) / notes.length
    : 0;

  // Voiced coverage saturates at 45% because natural takes contain breaths and
  // count-in silence. Continuity and octave stability carry the musical signal.
  const voicedScore = Math.min(1, voicedFramePercentage / 0.45);
  const baseConfidence = clamp01(
    voicedScore * 0.25 +
    pitchContinuity * 0.3 +
    octaveStability * 0.25 +
    segmentationConfidence * 0.2,
  );
  const melodyConfidence = notes.length > 0 ? baseConfidence : Math.min(0.49, baseConfidence * 0.6);
  return {
    melodyConfidence,
    estimatedNotes: notes.length,
    range: range?.label ?? null,
    clear: melodyConfidence >= MELODY_CONFIDENCE_THRESHOLD && notes.length > 0,
    voicedFramePercentage,
    pitchContinuity,
    octaveStability,
    segmentationConfidence,
  };
}

function emptyAssessment(): MelodyConfidence {
  return {
    melodyConfidence: 0,
    estimatedNotes: 0,
    range: null,
    clear: false,
    voicedFramePercentage: 0,
    pitchContinuity: 0,
    octaveStability: 0,
    segmentationConfidence: 0,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
