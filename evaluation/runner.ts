/**
 * The evaluation runner.
 *
 * One function per case kind, one report object out. The runner never asserts
 * anything — it measures. Assertions live in the quality gate, and thresholds
 * live in `expected/baseline.json`, so a benchmark run is always readable
 * independently of pass/fail.
 *
 * The voice path mirrors the worker exactly: extraction → judge (with the
 * measured-register authority flag) → phrase interpretation. If the worker's
 * flow changes, change it here too; an evaluation harness that drifts from the
 * product measures a system nobody ships.
 */

import { classifyInput } from '@intent';
import { detectOnsets } from '@audio-core';
import { extractHumanMelody } from '@/packages/melody-extraction';
import { buildMusicalPhraseModel } from '@/packages/musical-phrase';
import { judgeAndRepair, judgeFeaturesFromFrames } from '@musical-judge';
import { noteTransformations } from '@/packages/note-history';
import { arbitrateRegister } from '@evidence';
import { asExternalNotes, framesFromNotes } from './engines/external';
import { witnessesFor, type WitnessTier } from './engines/witness';
import { computeNoteMetrics, computePitchMetrics, type NoteMetrics, type PitchMetrics } from './metrics/pitch';
import { computeOnsetMetrics, type OnsetMetrics } from './metrics/rhythm';
import { computePreservation, type PreservationMetrics } from './metrics/preservation';
import { readPinnedWav } from './corpus';
import type { CorpusCase, PinnedCase } from './corpus';

export interface VoiceCaseReport {
  id: string;
  category: CorpusCase['category'];
  description: string;
  route: string;
  routeExpected: string | null;
  routeMatches: boolean;
  /**
   * The frame tracker's own accuracy, from the frames it produced.
   *
   * Grades the contour engine and nothing else. It is deliberately *not*
   * updated by the register arbitration: frames are physical measurements, and
   * rewriting them to agree with a later decision would destroy the one record
   * of what was actually heard. On `diff-octave-leap` this stays at 32.6%
   * octave error forever, because that is what YIN measured.
   */
  pitch: PitchMetrics;
  /**
   * The accuracy of what the product actually delivers, sampled from the notes.
   *
   * The number that answers "did the user get their melody back". It is the one
   * that moves when the register arbitration corrects an octave, and keeping it
   * separate from `pitch` is what stops either metric being quietly redefined
   * to look better: one grades the tracker, the other grades the result.
   */
  delivered: PitchMetrics;
  notes: NoteMetrics;
  /** What the second engine's register evidence changed, and what it could not. */
  register: { corrected: number; unresolved: number; witnessed: boolean };
  preservation: PreservationMetrics;
}

export interface RhythmCaseReport {
  id: string;
  category: CorpusCase['category'];
  description: string;
  route: string;
  routeExpected: string | null;
  routeMatches: boolean;
  onsets: OnsetMetrics;
}

export interface RoutingCaseReport {
  id: string;
  category: CorpusCase['category'];
  description: string;
  route: string;
  routeExpected: string;
  routeMatches: boolean;
}

export interface PinnedCaseReport {
  id: string;
  category: 'real-pinned';
  description: string;
  route: string;
  routeExpected: string | null;
  routeMatches: boolean;
  /** Octaves the second engine's evidence moved on a real take. */
  registerCorrected: number;
  /** Disagreements it raised that the evidence did not support acting on. */
  registerUnresolved: number;
  noteCount: number;
  medianPitch: number;
  distinctPitches: number;
}

export interface EvaluationReport {
  generatedAt: string;
  /** Which deployment configuration these numbers describe. */
  tier: WitnessTier;
  voice: VoiceCaseReport[];
  rhythm: RhythmCaseReport[];
  routing: RoutingCaseReport[];
  pinned: PinnedCaseReport[];
}

/** The judge flow below mirrors the worker exactly for voice material. */
export async function runVoiceCase(
  cases: readonly CorpusCase[],
  tier: WitnessTier = 'default',
): Promise<VoiceCaseReport[]> {
  const reports: VoiceCaseReport[] = [];
  for (const corpusCase of cases) {
    if (corpusCase.category !== 'voice-melody' && corpusCase.category !== 'difficult') continue;
    if (corpusCase.referenceNotes.length === 0) continue;
    const classification = classifyInput(corpusCase.audio);
    const extraction = extractHumanMelody(corpusCase.audio);

    // The register arbitration, in the same place the worker runs it: before
    // anything else reads the candidate. The witness comes from the committed
    // fixture rather than a live model — see `engines/witness.ts` — so the gate
    // grades the shipped path at the speed of a unit test.
    const register = arbitrateRegister(extraction.notes, witnessesFor(corpusCase.id, tier));
    const candidate = register.notes;

    const onsets = detectOnsets(corpusCase.audio.samples, corpusCase.audio.sampleRate)
      .onsets.map((onset) => onset.timeSec);
    const features = judgeFeaturesFromFrames(extraction.frames, corpusCase.audio.durationSec, onsets);
    const verdict = judgeAndRepair(candidate, features, {
      repair: { respectCandidateRegister: true },
    });
    const phraseModel = buildMusicalPhraseModel(candidate, {
      sourceKind: 'voice',
      interpretationNotes: verdict.judgedNotes,
      frames: extraction.frames,
      onsetsSec: onsets,
    });

    reports.push({
      id: corpusCase.id,
      category: corpusCase.category,
      description: corpusCase.description,
      route: classification.type,
      routeExpected: null,
      routeMatches: true,
      pitch: computePitchMetrics(
        corpusCase.referenceFrames,
        // The engine's frames carry `midiPitch`; the metric layer speaks in
        // neutral PitchObservations, so adapt here rather than there.
        extraction.frames.map((frame) => ({ timeSec: frame.timeSec, midi: frame.midiPitch })),
      ),
      delivered: computePitchMetrics(
        corpusCase.referenceFrames,
        framesFromNotes(asExternalNotes(verdict.judgedNotes), corpusCase.referenceFrames),
      ),
      notes: computeNoteMetrics(corpusCase.referenceNotes, candidate),
      register: {
        corrected: register.corrected,
        unresolved: register.unresolved,
        witnessed: witnessesFor(corpusCase.id, tier).length > 0,
      },
      preservation: computePreservation(
        [
          { stage: 'register', before: extraction.notes, after: candidate },
          { stage: 'judge', before: candidate, after: verdict.judgedNotes },
          { stage: 'interpretation', before: verdict.judgedNotes, after: phraseModel.interpretedNotes },
        ],
        [
          ...noteTransformations('register', extraction.notes, candidate),
          ...noteTransformations('judge', candidate, verdict.judgedNotes),
          ...noteTransformations('interpretation', verdict.judgedNotes, phraseModel.interpretedNotes),
        ],
      ),
    });
  }
  return reports;
}

export function runRhythmCases(cases: readonly CorpusCase[]): RhythmCaseReport[] {
  const reports: RhythmCaseReport[] = [];
  for (const corpusCase of cases) {
    if (corpusCase.category !== 'rhythm' || !corpusCase.referenceOnsets) continue;
    const classification = classifyInput(corpusCase.audio);
    const detection = detectOnsets(corpusCase.audio.samples, corpusCase.audio.sampleRate);
    reports.push({
      id: corpusCase.id,
      category: corpusCase.category,
      description: corpusCase.description,
      route: classification.type,
      routeExpected: corpusCase.expectedRoute ?? null,
      routeMatches: classification.type === corpusCase.expectedRoute,
      onsets: computeOnsetMetrics(
        corpusCase.referenceOnsets,
        detection.onsets.map((onset) => onset.timeSec),
      ),
    });
  }
  return reports;
}

export function runRoutingCases(cases: readonly CorpusCase[]): RoutingCaseReport[] {
  const reports: RoutingCaseReport[] = [];
  for (const corpusCase of cases) {
    if (!corpusCase.expectedRoute) continue;
    const classification = classifyInput(corpusCase.audio);
    reports.push({
      id: corpusCase.id,
      category: corpusCase.category,
      description: corpusCase.description,
      route: classification.type,
      routeExpected: corpusCase.expectedRoute,
      routeMatches: classification.type === corpusCase.expectedRoute,
    });
  }
  return reports;
}

/**
 * The pinned real takes, through the same path the product runs.
 *
 * Including the register arbitration. These recordings are the only material in
 * the harness that was actually performed by a person, so a change that helps
 * the synthesised corpus and quietly harms a real take has to be visible here
 * or it is not visible anywhere.
 */
export function runPinnedCases(
  pinned: readonly PinnedCase[],
  tier: WitnessTier = 'default',
): PinnedCaseReport[] {
  return pinned.map((pin) => {
    const audio = readPinnedWav(pin.wavPath);
    const classification = classifyInput(audio);
    const extraction = extractHumanMelody(audio);
    const register = arbitrateRegister(extraction.notes, witnessesFor(pin.id, tier));
    const pitches = register.notes.map((note) => note.pitch);
    return {
      id: pin.id,
      category: 'real-pinned' as const,
      description: pin.description,
      route: classification.type,
      routeExpected: pin.expectedRoute ?? null,
      routeMatches: pin.expectedRoute === undefined || classification.type === pin.expectedRoute,
      registerCorrected: register.corrected,
      registerUnresolved: register.unresolved,
      noteCount: register.notes.length,
      medianPitch:
        pitches.length > 0
          ? [...pitches].sort((a, b) => a - b)[Math.floor(pitches.length / 2)] ?? 0
          : 0,
      distinctPitches: new Set(pitches).size,
    };
  });
}

export async function evaluateAll(
  synthesised: readonly CorpusCase[],
  pinned: readonly PinnedCase[],
  tier: WitnessTier = 'default',
): Promise<EvaluationReport> {
  const [voice] = await Promise.all([runVoiceCase(synthesised, tier)]);
  return {
    generatedAt: new Date().toISOString(),
    tier,
    voice,
    rhythm: runRhythmCases(synthesised),
    routing: runRoutingCases(synthesised),
    pinned: runPinnedCases(pinned, tier),
  };
}
