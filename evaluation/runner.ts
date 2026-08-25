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
  pitch: PitchMetrics;
  notes: NoteMetrics;
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
  noteCount: number;
  medianPitch: number;
  distinctPitches: number;
}

export interface EvaluationReport {
  generatedAt: string;
  voice: VoiceCaseReport[];
  rhythm: RhythmCaseReport[];
  routing: RoutingCaseReport[];
  pinned: PinnedCaseReport[];
}

/** The judge flow below mirrors the worker exactly for voice material. */
export async function runVoiceCase(cases: readonly CorpusCase[]): Promise<VoiceCaseReport[]> {
  const reports: VoiceCaseReport[] = [];
  for (const corpusCase of cases) {
    if (corpusCase.category !== 'voice-melody' && corpusCase.category !== 'difficult') continue;
    if (corpusCase.referenceNotes.length === 0) continue;
    const classification = classifyInput(corpusCase.audio);
    const extraction = extractHumanMelody(corpusCase.audio);
    const onsets = detectOnsets(corpusCase.audio.samples, corpusCase.audio.sampleRate)
      .onsets.map((onset) => onset.timeSec);
    const features = judgeFeaturesFromFrames(extraction.frames, corpusCase.audio.durationSec, onsets);
    const verdict = judgeAndRepair(extraction.notes, features, {
      repair: { respectCandidateRegister: true },
    });
    const phraseModel = buildMusicalPhraseModel(extraction.notes, {
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
      notes: computeNoteMetrics(corpusCase.referenceNotes, extraction.notes),
      preservation: computePreservation(
        [
          { stage: 'judge', before: extraction.notes, after: verdict.judgedNotes },
          { stage: 'interpretation', before: verdict.judgedNotes, after: phraseModel.interpretedNotes },
        ],
        [
          ...noteTransformations('judge', extraction.notes, verdict.judgedNotes),
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

export function runPinnedCases(pinned: readonly PinnedCase[]): PinnedCaseReport[] {
  return pinned.map((pin) => {
    const audio = readPinnedWav(pin.wavPath);
    const classification = classifyInput(audio);
    const extraction = extractHumanMelody(audio);
    const pitches = extraction.notes.map((note) => note.pitch);
    return {
      id: pin.id,
      category: 'real-pinned' as const,
      description: pin.description,
      route: classification.type,
      routeExpected: pin.expectedRoute ?? null,
      routeMatches: pin.expectedRoute === undefined || classification.type === pin.expectedRoute,
      noteCount: extraction.notes.length,
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
): Promise<EvaluationReport> {
  const [voice] = await Promise.all([runVoiceCase(synthesised)]);
  return {
    generatedAt: new Date().toISOString(),
    voice,
    rhythm: runRhythmCases(synthesised),
    routing: runRoutingCases(synthesised),
    pinned: runPinnedCases(pinned),
  };
}
