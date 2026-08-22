/**
 * Behaviour the product needs that `humtool.py` does not provide.
 *
 * Everything here is an *addition*, kept out of `port.ts` on purpose so the
 * port stays verifiable against the Python reference (US-0401). Each function
 * documents the story it satisfies and the rule it follows, because these are
 * the parts a future agent is most likely to "improve" by accident.
 *
 * Two properties every function in this file must hold:
 *  - deterministic: same input, same output, no clocks and no randomness;
 *  - monotonic in strength: raising the strength never un-cleans something a
 *    lower strength already cleaned. The Raw-to-Clean macro depends on it.
 */

import {
  drumVoiceOf,
  UNKNOWN_DRUM_FALLBACK,
  type DrumEvent,
  type GridDrum,
  type GridNote,
  type KeyMode,
  type NoteEvent,
  type PitchClassName,
} from '@contracts';
import { clamp, lerp, mod, pyRound } from './numeric';
import { MAJOR_SCALE_DEGREES, MINOR_SCALE_DEGREES, scaleSnapDelta } from './port';
import { PITCH_CLASS_NAMES } from '@contracts';

export interface MergeResult {
  notes: NoteEvent[];
  /** Notes folded into a neighbour because they were the same pitch re-articulated. */
  merged: number;
  /** Notes discarded as transcription specks. */
  removed: number;
}

/**
 * US-0406 / PRD C-05 - merge short notes and remove noise.
 *
 * Basic Pitch and any pitch tracker emit two artefacts on hummed input: a held
 * note broken into several fragments of the same pitch, and isolated specks a
 * few tens of milliseconds long. The first is fixed by merging, the second by
 * dropping.
 *
 * The acceptance criterion "legitimate short articulations are not
 * systematically erased" is enforced structurally rather than by taste: the
 * effective floor is capped at half a grid step, so a note the user could
 * actually have placed on the grid is never dropped no matter how high the
 * macro goes.
 */
export function mergeShortNotes(
  notes: readonly NoteEvent[],
  options: {
    /** Notes shorter than this are candidates for merge/removal, in seconds. */
    minDurationSec: number;
    /** Same-pitch notes closer than this are treated as one articulation. */
    maxGapSec: number;
    /** One grid step in seconds. Caps the floor so real subdivisions survive. */
    stepSec: number;
  },
): MergeResult {
  if (notes.length === 0) return { notes: [], merged: 0, removed: 0 };

  const floor = Math.min(options.minDurationSec, options.stepSec * 0.5);
  const gap = Math.min(options.maxGapSec, options.stepSec * 0.5);
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);

  const out: NoteEvent[] = [];
  let merged = 0;
  let removed = 0;

  for (const note of sorted) {
    const previous = out[out.length - 1];
    const isSamePitchContinuation =
      previous !== undefined &&
      previous.pitch === note.pitch &&
      note.startSec - previous.endSec <= gap;

    if (isSamePitchContinuation) {
      // Extend rather than replace: a re-articulated hum is one musical note.
      previous.endSec = Math.max(previous.endSec, note.endSec);
      previous.velocity = Math.max(previous.velocity, note.velocity);
      merged += 1;
      continue;
    }

    if (note.endSec - note.startSec < floor) {
      removed += 1;
      continue;
    }

    out.push({ ...note });
  }

  return { notes: out, merged, removed };
}

export interface PartialSnapResult {
  notes: NoteEvent[];
  moved: number;
}

/**
 * US-0405 / PRD C-04 - scale snapping with adjustable strength.
 *
 * `snap_to_scale` in the Python reference is all-or-nothing. It has to be:
 * against the major and minor scales every out-of-key pitch class is exactly
 * one semitone from a scale degree, so there is no "snap distance" to threshold
 * on. Strength therefore selects *which* notes get corrected, not how far.
 *
 * Ranking rule: longest out-of-key notes first. A held wrong note is what a
 * listener actually hears as a mistake; a passing one is often just the shape
 * of the hum. At strength 0 nothing moves; at strength 1 every out-of-key note
 * moves, which is bit-for-bit the ported behaviour. Ties break by onset then
 * pitch so the selection is stable across runs.
 */
export function snapToScalePartial(
  notes: readonly NoteEvent[],
  root: PitchClassName,
  mode: KeyMode,
  strength: number,
): PartialSnapResult {
  const amount = clamp(strength, 0, 1);
  if (amount === 0 || notes.length === 0) {
    return { notes: notes.map((n) => ({ ...n })), moved: 0 };
  }

  const scale = mode === 'major' ? MAJOR_SCALE_DEGREES : MINOR_SCALE_DEGREES;
  const rootIndex = PITCH_CLASS_NAMES.indexOf(root);

  const candidates: number[] = [];
  notes.forEach((note, index) => {
    if (!scale.includes(mod(note.pitch - rootIndex, 12))) candidates.push(index);
  });

  candidates.sort((a, b) => {
    const na = notes[a] as NoteEvent;
    const nb = notes[b] as NoteEvent;
    const durationDiff = nb.endSec - nb.startSec - (na.endSec - na.startSec);
    if (durationDiff !== 0) return durationDiff;
    return na.startSec - nb.startSec || na.pitch - nb.pitch;
  });

  const toMove = Math.ceil(candidates.length * amount);
  const selected = new Set(candidates.slice(0, toMove));

  const out = notes.map((note, index) => {
    if (!selected.has(index)) return { ...note };
    const pc = mod(note.pitch - rootIndex, 12);
    return { ...note, pitch: note.pitch + scaleSnapDelta(pc, scale) };
  });

  return { notes: out, moved: selected.size };
}

/**
 * US-0403 / US-0407 - quantization with adjustable strength.
 *
 * Interpolates each note between where it was performed and where the grid
 * wants it. Strength 1 reproduces the ported `quantize` timing exactly (the
 * same round-half-to-even, the same minimum length); strength 0 leaves the
 * performance untouched.
 *
 * Duplicate collapsing follows the port's rule - a note landing on the same
 * step at the same pitch as its predecessor is dropped - but only once the user
 * has asked for some correction. At strength 0 the promise is "this is exactly
 * what you sang", and silently removing events would break it.
 */
export function quantizeWithStrength(
  notes: readonly NoteEvent[],
  options: { stepSec: number; strength: number; minLengthSteps?: number },
): NoteEvent[] {
  const { stepSec } = options;
  const amount = clamp(options.strength, 0, 1);
  const minLen = options.minLengthSteps ?? 1;
  const out: NoteEvent[] = [];
  let lastStep: number | null = null;
  let lastPitch: number | null = null;

  for (const note of [...notes].sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch)) {
    const step = pyRound(note.startSec / stepSec);
    const lengthSteps = Math.max(minLen, pyRound((note.endSec - note.startSec) / stepSec));

    if (amount > 0 && lastStep === step && lastPitch === note.pitch) continue;
    lastStep = step;
    lastPitch = note.pitch;

    const targetStart = step * stepSec;
    const targetEnd = targetStart + lengthSteps * stepSec;
    const startSec = lerp(note.startSec, targetStart, amount);
    const endSec = lerp(note.endSec, targetEnd, amount);

    out.push({
      ...note,
      startSec: Math.max(0, startSec),
      // A zero-length note is not renderable; the floor is a tenth of a step.
      endSec: Math.max(startSec + stepSec * 0.1, endSec),
    });
  }

  out.sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
  return out;
}

/**
 * Pulls velocities toward their mean as cleanup rises.
 *
 * Transcribed velocity on a hummed take is mostly microphone distance, not
 * intent, and wild dynamics are one of the things that make an otherwise decent
 * sketch sound accidental. At strength 0 the performance dynamics are intact.
 */
export function smoothVelocities(notes: readonly NoteEvent[], strength: number): NoteEvent[] {
  const amount = clamp(strength, 0, 1);
  if (amount === 0 || notes.length === 0) return notes.map((n) => ({ ...n }));
  const mean = notes.reduce((total, n) => total + n.velocity, 0) / notes.length;
  return notes.map((note) => ({
    ...note,
    velocity: Math.round(clamp(lerp(note.velocity, mean, amount * 0.6), 20, 127)),
  }));
}

/** Clamps pitches into a range a rendered instrument can actually voice. */
export function clampToPlayableRange(
  notes: readonly NoteEvent[],
  low: number,
  high: number,
): NoteEvent[] {
  return notes.map((note) => {
    let pitch = note.pitch;
    while (pitch < low) pitch += 12;
    while (pitch > high) pitch -= 12;
    return { ...note, pitch: clamp(pitch, 0, 127) };
  });
}

export interface DrumQuantizeResult {
  drums: DrumEvent[];
  gridDrums: GridDrum[];
  /** Events discarded because a louder hit of the same class held the step. */
  collisions: number;
}

/**
 * Two hits of one voice this close are heard as one, so quantization is not
 * allowed to close the gap entirely.
 *
 * Thirty milliseconds is roughly where a flam stops being two strokes and
 * becomes one thicker one. Below that, "both events survived" would be true of
 * the data and false of the sound.
 */
const MIN_VOICE_SEPARATION_SEC = 0.03;

export interface DrumQuantizeOptions {
  stepSec: number;
  strength: number;
  /**
   * Whether two hits of the same voice on one step may be treated as one
   * detection of one physical event.
   *
   * True for audio, where a single beatboxed hit really can be detected twice
   * and keeping both is a transcription error. False for anything symbolic: a
   * MIDI file has no detection uncertainty to clean up, so two events in it are
   * two events, and deleting one is not a correction of anything.
   */
  mergeDuplicateDetections: boolean;
}

/**
 * US-0504 - quantize rhythm events.
 *
 * Same grid and same strength curve as the melody path, so the Raw-to-Clean
 * control means the same thing in both modes.
 *
 * ## What changed, and the eight hits that paid for it
 *
 * The collision rule used to be: two hits of the same *drum class* on one step,
 * the louder wins, the other is dropped. That is a sound rule when the class is
 * the finest thing anyone knows about a hit — a beatboxed kick detected twice
 * is one kick.
 *
 * It stopped being true when imported rhythms arrived. A real file had fifteen
 * pitched layers rendered through a three-slot kit, so "the same drum class"
 * became true of pairs that had nothing to do with each other, and the default
 * cleanup deleted one of every such pair: eight hits, every one of them a
 * different part from the one that survived, none of them a duplicate.
 *
 * So collisions are now keyed on `voice` — the identity the source actually
 * knows — and merging is off entirely for symbolic sources. Distinct source
 * events stay distinct events at every cleanup setting; what cleanup moves is
 * their timing.
 *
 * ## Why a minimum separation
 *
 * Full quantization pulls everything onto a step, and two hits of one voice a
 * tenth of a second apart would land on the same instant — surviving as data
 * and vanishing as sound. They are held `MIN_VOICE_SEPARATION_SEC` apart, in
 * their original order. A hard grid is what the user asked for; a hit they can
 * no longer hear is not.
 */
export function quantizeDrums(
  drums: readonly DrumEvent[],
  options: DrumQuantizeOptions,
): DrumQuantizeResult {
  const amount = clamp(options.strength, 0, 1);
  const { stepSec } = options;
  const sorted = [...drums].sort((a, b) => a.timeSec - b.timeSec);

  const held = new Map<string, DrumEvent>();
  const ordered: Array<{ key: string; step: number; drum: DrumEvent }> = [];
  let collisions = 0;

  for (const event of sorted) {
    const drum = event.drum === 'unknown' ? UNKNOWN_DRUM_FALLBACK : event.drum;
    const step = pyRound(event.timeSec / stepSec);
    // Identity, not sound. Two layers sharing a kit slot are still two layers.
    const key = `${step}:${drumVoiceOf(event)}`;
    const target = step * stepSec;
    const moved: DrumEvent = { ...event, drum, timeSec: lerp(event.timeSec, target, amount) };

    const existing = held.get(key);
    if (amount > 0 && existing !== undefined && options.mergeDuplicateDetections) {
      // Counts merges, not near-misses. Two events landing on one step is only
      // interesting if one of them stopped existing because of it.
      collisions += 1;
      if (moved.velocity > existing.velocity) {
        existing.velocity = moved.velocity;
        existing.confidence = Math.max(existing.confidence, moved.confidence);
      }
      continue;
    }
    if (existing === undefined) held.set(key, moved);
    ordered.push({ key, step, drum: moved });
  }

  const result = ordered.map((entry) =>
    entry.drum === held.get(entry.key) ? (held.get(entry.key) as DrumEvent) : entry.drum,
  );
  separateVoices(result);

  const gridDrums: GridDrum[] = ordered.map((entry, index) => {
    const drum = result[index] as DrumEvent;
    return { step: entry.step, drum: drum.drum, velocity: drum.velocity };
  });

  result.sort((a, b) => a.timeSec - b.timeSec);
  gridDrums.sort((a, b) => a.step - b.step);
  return { drums: result, gridDrums, collisions };
}

/**
 * Keeps two hits of one voice audibly apart after quantization.
 *
 * In place and in source order, so the later of two hits stays the later one.
 * Only ever pushes forward, and only far enough to be heard.
 */
function separateVoices(events: DrumEvent[]): void {
  const lastByVoice = new Map<string, number>();
  const inOrder = [...events].sort((a, b) => a.timeSec - b.timeSec);
  for (const event of inOrder) {
    const voice = drumVoiceOf(event);
    const previous = lastByVoice.get(voice);
    if (previous !== undefined && event.timeSec - previous < MIN_VOICE_SEPARATION_SEC) {
      event.timeSec = previous + MIN_VOICE_SEPARATION_SEC;
    }
    lastByVoice.set(voice, event.timeSec);
  }
}

/** Converts final second-based notes into the grid view the port's report uses. */
export function toGridNotes(notes: readonly NoteEvent[], stepSec: number): GridNote[] {
  return notes
    .map((note) => ({
      step: pyRound(note.startSec / stepSec),
      lengthSteps: Math.max(1, pyRound((note.endSec - note.startSec) / stepSec)),
      pitch: note.pitch,
      velocity: note.velocity,
    }))
    .sort((a, b) => a.step - b.step || a.pitch - b.pitch);
}
