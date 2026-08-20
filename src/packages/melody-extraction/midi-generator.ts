import type { NoteEvent } from '@contracts';
import type { MelodySegment } from './segmentation';

/** Emits a strict one-note-at-a-time stream while preserving measured timing. */
export function generateMelodyNoteEvents(segments: readonly MelodySegment[]): NoteEvent[] {
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const notes: NoteEvent[] = [];
  for (const segment of sorted) {
    const previous = notes.at(-1);
    const startSec = previous ? Math.max(previous.endSec, segment.startSec) : segment.startSec;
    if (segment.endSec <= startSec) continue;
    notes.push({
      startSec,
      endSec: segment.endSec,
      pitch: Math.max(0, Math.min(127, Math.round(segment.midiPitch))),
      velocity: velocityFromExpression(segment.confidence, segment.intensity),
      confidence: Math.max(0, Math.min(1, segment.confidence)),
    });
  }
  return notes;
}

export function maximumPolyphony(notes: readonly NoteEvent[]): number {
  const points = notes.flatMap((note) => [
    { time: note.startSec, delta: 1 },
    { time: note.endSec, delta: -1 },
  ]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function velocityFromExpression(confidence: number, intensity: number): number {
  const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-5, intensity)) + 48) / 42));
  return Math.max(25, Math.min(127, Math.round(25 + 58 * level + 44 * confidence)));
}
