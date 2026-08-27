/**
 * The canonical evidence model.
 *
 * ## Why the pipeline stopped having one oracle
 *
 * For most of this project's life a single chain — YIN, contour smoothing,
 * segmentation — was the transcription, and every accuracy problem was a bug in
 * it to be repaired until correct. That framing has a ceiling, and the
 * evaluation corpus shows exactly where it sits: on `diff-octave-leap`, a
 * C4→C5→C4 phrase with exact ground truth, the chain reports C4→C4→C4. Its
 * frame tracking is 98.9% correct *modulo the octave*; the register is wrong
 * one note in three. That is not a tuning failure. YIN locks onto a subharmonic
 * and is then perfectly confident, and no amount of reasoning over its own
 * output can recover information it never had.
 *
 * A second, independent measurement can. Basic Pitch — already a dependency,
 * already loaded for the instrument path — reports that phrase as C4→C5→C4 with
 * no octave errors at all, while producing note boundaries far worse than the
 * chain's: twenty-four notes for one held tone on `voice-vibrato`, where the
 * chain reports one.
 *
 * Neither engine is better. They are good at different questions, and the
 * measured split is clean enough to build on:
 *
 * ```
 *                  what it is trusted for
 * melody-contour   boundaries, voicing, continuity
 * basic-pitch      register
 * game             boundaries and register (optional; see the service adapter)
 * ```
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the vocabulary for holding several engines' readings of one recording
 * on that recording's own clock, together with what each engine is trusted for
 * and where they disagreed.
 *
 * It is *not* a general fusion framework. Only one arbitration is implemented —
 * register — because that is the only one the measurements currently justify.
 * Building the rest speculatively would mean writing weighting rules whose
 * effect nobody has observed, which is the failure mode this whole architecture
 * exists to leave behind. `EngineStrengths` names the other dimensions so that
 * adding an arbitration later is filling in a declared blank rather than
 * inventing a vocabulary.
 */

import type { NoteEvent } from '@contracts';

/** An engine that can produce evidence about a recording. */
export type EvidenceEngineId = 'melody-contour' | 'basic-pitch' | 'game' | 'harmonic-spectrum';

/**
 * Which rendering of the source an engine read.
 *
 * The original signal is always available and is what everything currently
 * reads. The other views exist because a denoiser that makes a recording
 * cleaner to a human can remove harmonics a pitch model needed, so an enhanced
 * view has to be an *addition* to the evidence rather than a replacement for
 * it — which means the identity of the view has to travel with the reading.
 */
export type AudioViewId = 'original' | 'normalized' | 'denoised' | 'voice-isolated';

/**
 * One engine's claim about one span, in absolute source seconds.
 *
 * Pitch is fractional MIDI rather than an integer: engines that report
 * continuous pitch are saying something more precise than a note number, and
 * rounding at the boundary would throw it away before anything could use it.
 */
export interface EvidenceNote {
  startSec: number;
  endSec: number;
  pitch: number;
  /** The engine's own confidence, 0..1, where it reports one. */
  confidence?: number;
}

/**
 * How far an engine is trusted, per dimension, 0..1.
 *
 * Measured rather than assumed — see `ENGINE_STRENGTHS` — and separated by
 * dimension because the whole point is that an engine can be authoritative
 * about one thing and unusable about another.
 */
export interface EngineStrengths {
  /** Note starts and ends. */
  boundaries: number;
  /** Which octave a pitch sits in. */
  register: number;
  /** Which pitch class it is, ignoring octave. */
  pitchClass: number;
  /** Whether anything is sounding at all. */
  voicing: number;
}

/**
 * What each engine is trusted for, from the corpus measurements.
 *
 * The numbers come from `evaluation/` runs on material with exact ground truth,
 * and the ordering between engines is what matters rather than the absolute
 * values. Recorded here so a claim about an engine's competence has a place to
 * live other than a comment, and so changing one is a visible decision.
 *
 * - `melody-contour`: note F1 1.00 on every steady case, and the only engine
 *   that reports one held note as one note. Register 0.2 because it is the
 *   engine whose register failure motivated all of this.
 * - `basic-pitch`: 0% octave error across the corpus, including the case the
 *   contour engine gets wrong 33% of the time. Boundaries 0.15 because it split
 *   one held tone into twenty-four notes.
 * - `game`: better than both on the octave case (2.2% error) with tighter
 *   onsets than either (10–20 ms against 20–30 ms), and worse than the contour
 *   engine on low register. Optional, so its strengths only matter when the
 *   adapter is actually configured.
 * - `harmonic-spectrum`: reads the recording's own spectrum and answers exactly
 *   one question — which octave carries the fundamental. It has no opinion
 *   about boundaries, voicing or pitch class, and its entries below say so.
 *   Its value is that it shares no code, model or failure mode with the other
 *   three, so agreement with it is genuinely independent corroboration. It is
 *   also the only second witness available in a default deployment, where GAME
 *   is not running.
 */
export const ENGINE_STRENGTHS: Readonly<Record<EvidenceEngineId, EngineStrengths>> = Object.freeze({
  'melody-contour': { boundaries: 0.9, register: 0.2, pitchClass: 0.85, voicing: 0.9 },
  'basic-pitch': { boundaries: 0.15, register: 0.85, pitchClass: 0.7, voicing: 0.4 },
  game: { boundaries: 0.95, register: 0.9, pitchClass: 0.9, voicing: 0.75 },
  // Register only. The zeros are not modesty: this witness emits one pitch per
  // span handed to it and would be actively wrong if consulted about anything
  // else.
  'harmonic-spectrum': { boundaries: 0, register: 0.75, pitchClass: 0, voicing: 0 },
});

/**
 * One engine's complete reading of one recording.
 *
 * `notes` are on the source's clock, always. An engine that had to be given the
 * audio in pieces is the adapter's problem, not the evidence model's: a chunk
 * boundary exists because a computer needed smaller input and must never reach
 * anything that describes the music.
 */
export interface EvidenceSource {
  engineId: EvidenceEngineId;
  view: AudioViewId;
  notes: readonly EvidenceNote[];
  /** Wall-clock cost, so the deployment cost of an engine is a recorded fact. */
  elapsedMs?: number;
}

/** Narrows an engine's reading to the one question it is being asked. */
export function strengthsOf(engineId: EvidenceEngineId): EngineStrengths {
  return ENGINE_STRENGTHS[engineId];
}

/** Adapts the note contract to the evidence contract. */
export function asEvidenceNotes(notes: readonly NoteEvent[]): EvidenceNote[] {
  return notes.map((note) => ({
    startSec: note.startSec,
    endSec: note.endSec,
    pitch: note.pitch,
    ...(note.confidence === undefined ? {} : { confidence: note.confidence }),
  }));
}
