/**
 * The user's discovery, turned into a failing assertion.
 *
 * ## What was reported
 *
 * "The app says *heard at 85, but you selected 120*, and the music comes out
 * worse. The same melody at the same speed gives a better result when I happen
 * to pick 85 before recording."
 *
 * A number chosen before there was any music to have an opinion about was
 * reaching the interpretation of the performance that followed. That is not a
 * tuning problem to be improved; it is a category error, and the fix was to
 * remove the choice rather than to arbitrate it better.
 *
 * ## What this file proves
 *
 * Four things, at four different levels, because a single end-to-end assertion
 * would pass just as happily if the dependency had merely been hidden:
 *
 *  1. **Structurally** — nothing in the creation state can hold a chosen tempo,
 *     and the one BPM field that remains is source metadata that a new source
 *     clears.
 *  2. **At the reducer** — a stale action from the old design is inert, so a
 *     rehydrated pre-removal record cannot dispatch its way back in.
 *  3. **At the state machine** — there is no event that gates recording on a
 *     tempo, and `idle` accepts `ARM` directly.
 *  4. **End to end** — the same audio, carried through the real extraction,
 *     Judge and version-planning path inside two states that differ *only* in
 *     obsolete tempo fields, produces byte-identical evidence and an identical
 *     Faithful reading.
 *
 * Any internally inferred rhythm metadata may differ only if the source audio
 * differs, which (4) also covers: the two runs share one audio buffer.
 */

import { describe, expect, it } from 'vitest';
import type { MonoAudio, NoteEvent, ProcessingDiagnostics } from '@contracts';
import { detectOnsets } from '@audio-core';
import { extractHumanMelody } from '@/packages/melody-extraction';
import { judgeAndRepair, judgeFeaturesFromFrames } from '@musical-judge';
import { buildMusicalPhraseModel } from '@/packages/musical-phrase';
import { analyzeMelodyRhythm, encodingBpm, planVersions, resolveVersionTempo } from '@rhythm-extraction';
import { refine } from '@retouch';
import { INITIAL_CONTEXT, transition } from '@/features/state/machine';
import {
  beginNewSource,
  initialState,
  reducer,
  SOURCE_DERIVED_FIELDS,
  type Action,
  type FlowState,
} from '@/features/creation/state';

/**
 * The two numbers from the report.
 *
 * They appear here only as things the product must be unable to notice.
 */
const REPORTED_HEARD_BPM = 85;
const REPORTED_SELECTED_BPM = 120;

const RATE = 16_000;

/**
 * A hummed phrase at roughly 85 BPM, synthesised deterministically.
 *
 * Real enough for the pitch tracker and the onset detector to have opinions
 * about, and identical on every machine, so a difference between the two runs
 * below can only have come from the state around them.
 */
function hummedPhrase(): MonoAudio {
  const beatSec = 60 / REPORTED_HEARD_BPM;
  const midi = [62, 64, 65, 67, 65, 64, 62];
  const samples = new Float32Array(Math.round(RATE * (midi.length * beatSec + 0.5)));

  midi.forEach((note, index) => {
    const hz = 440 * Math.pow(2, (note - 69) / 12);
    const start = Math.round(index * beatSec * RATE);
    const length = Math.round(beatSec * 0.85 * RATE);
    for (let i = 0; i < length && start + i < samples.length; i += 1) {
      const t = i / RATE;
      // A short fade at each end so the segmenter sees note boundaries rather
      // than one continuous tone with clicks in it.
      const envelope = Math.min(1, t / 0.03, (length / RATE - t) / 0.05);
      const phase = 2 * Math.PI * hz * t;
      samples[start + i] =
        envelope * 0.5 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.18 * Math.sin(3 * phase));
    }
  });

  return { samples, sampleRate: RATE, durationSec: samples.length / RATE };
}

const DIAGNOSTICS: ProcessingDiagnostics = {
  transcriberId: 'melody-extraction',
  backend: 'browser',
  elapsedMs: 1,
  modelLoadMs: 0,
  modelFromCache: true,
  notesBeforeFilter: 7,
  notesAfterFilter: 7,
  warnings: [],
};

/**
 * The shape a pre-removal record had, spread onto the current state.
 *
 * This is the migration hazard the guide names: not a user action, but data
 * from before the change arriving in a state object that no longer declares
 * these fields. The cast is the whole point — TypeScript would reject them, and
 * a stored JSON blob will not.
 */
function withLegacyTempoFields(state: FlowState, bpm: number): FlowState {
  return {
    ...state,
    bpm,
    tempoChoice: 'metronome',
    metronomeMuted: false,
    tapHistory: [0, 60 / bpm, 120 / bpm, 180 / bpm],
    tapCount: 4,
  } as unknown as FlowState;
}

/**
 * The whole melody path, run exactly as the worker and the hook run it.
 *
 * Takes the surrounding flow state so that a dependency on it would show up as
 * a difference between the two calls below. Returns everything a user could
 * hear or export: the candidate notes, the Judge's Faithful reading, the
 * inferred rhythm metadata, and the version plan with its tempi.
 */
function interpret(audio: MonoAudio, state: FlowState) {
  const extraction = extractHumanMelody(audio);
  const onsets = detectOnsets(audio.samples, audio.sampleRate).onsets.map((o) => o.timeSec);
  const features = judgeFeaturesFromFrames(extraction.frames, audio.durationSec, onsets);
  const verdict = judgeAndRepair(extraction.notes, features, {
    repair: { respectCandidateRegister: true },
  });
  const phraseModel = buildMusicalPhraseModel(extraction.notes, {
    sourceKind: 'voice',
    interpretationNotes: verdict.judgedNotes,
    frames: extraction.frames,
    onsetsSec: onsets,
  });

  // Assembled exactly as the worker assembles it, so the reducer receives the
  // shape it receives in production rather than a convenient stand-in.
  const settled = reducer(state, {
    type: 'transcribed',
    notes: extraction.notes,
    judge: {
      notes: verdict.judgedNotes,
      score: verdict.judgedScore.overall,
      scoreBefore: verdict.originalScore.overall,
      repairs: verdict.repairs.map((step) => step.description),
      unsupportedNotesRemoved: 0,
      octaveErrorsCorrected: 0,
    },
    phraseModel,
    referenceNotes: extraction.notes,
    drums: [],
    diagnostics: DIAGNOSTICS,
    melodyQuality: extraction.quality,
  });

  const rhythm = analyzeMelodyRhythm(settled.judge?.notes ?? settled.rawNotes, audio.durationSec);
  const tempo = resolveVersionTempo({ rhythm });
  const versions = planVersions({ rhythm, mode: settled.mode, amount: settled.retouchAmount });
  const faithful = versions.find((version) => version.id === 'unprocessed');

  return {
    candidate: extraction.notes,
    faithfulNotes: verdict.judgedNotes,
    repairs: verdict.repairs,
    interpretedNotes: phraseModel.interpretedNotes,
    tempo,
    encodedBpm: encodingBpm(tempo),
    versions,
    // The Faithful version as it is actually heard: notes through retouch at
    // the recipe the picker would have selected.
    faithfulPlayed: refine(
      { notes: verdict.judgedNotes, drums: [] },
      {
        bpm: faithful?.bpm ?? encodingBpm(tempo),
        mode: 'melody',
        amount: faithful?.amount ?? 0,
        paramOverrides: faithful?.paramOverrides,
      },
    ).notes,
  };
}

describe('the creation state cannot hold a chosen tempo', () => {
  const state = initialState('sketch-1');

  it('declares no field a metronome or a tap could write to', () => {
    const forbidden = /^(bpm|tempoChoice|metronomeMuted|tapHistory|tapCount)$/;
    expect(Object.keys(state).filter((key) => forbidden.test(key))).toEqual([]);
  });

  it('keeps an imported file’s stated tempo, and only that', () => {
    // A MIDI file declaring its own tempo is stating a fact about the music. It
    // is kept for encoding and is never offered as a setting, which is why it is
    // the one BPM-shaped field left.
    expect(state.sourceTempoBpm).toBeNull();
    expect(SOURCE_DERIVED_FIELDS).toContain('sourceTempoBpm');
    // And so a new source clears it, rather than one file's tempo describing the
    // next recording.
    expect(beginNewSource({ ...state, sourceTempoBpm: 96 }).sourceTempoBpm).toBeNull();
  });
});

describe('a stale action from the old design', () => {
  it('is inert rather than accepted', () => {
    const before = initialState('sketch-1');
    for (const stale of ['setBpm', 'tap', 'toggleMetronome', 'setTempoChoice', 'beat']) {
      const after = reducer(before, { type: stale, bpm: REPORTED_SELECTED_BPM } as unknown as Action);
      expect({ stale, state: after }).toEqual({ stale, state: before });
    }
  });
});

describe('the state machine', () => {
  it('offers recording immediately, with nothing to establish first', () => {
    expect(transition(INITIAL_CONTEXT, 'ARM').accepted).toBe(true);
  });

  it('has no event that could mean “a tempo was set”', () => {
    for (const stale of ['TEMPO_SET', 'COUNT_IN_STARTED']) {
      expect({ stale, accepted: transition(INITIAL_CONTEXT, stale as never).accepted }).toEqual({
        stale,
        accepted: false,
      });
    }
  });
});

describe('the same audio inside two different legacy tempo states', () => {
  const audio = hummedPhrase();
  const base = initialState('sketch-1');
  const heard = interpret(audio, withLegacyTempoFields(base, REPORTED_HEARD_BPM));
  const selected = interpret(audio, withLegacyTempoFields(base, REPORTED_SELECTED_BPM));

  it('produces identical transcription evidence', () => {
    expect(selected.candidate).toEqual(heard.candidate);
    expect(selected.interpretedNotes).toEqual(heard.interpretedNotes);
  });

  it('produces an identical Faithful reading, repairs included', () => {
    expect(selected.faithfulNotes).toEqual(heard.faithfulNotes);
    expect(selected.repairs).toEqual(heard.repairs);
  });

  it('produces the identical Faithful version as it is actually heard', () => {
    // The end of the chain, and the thing the user complained about: not just
    // the note list, but the notes after the version recipe and retouch have
    // been applied at whatever tempo the app decided on.
    expect(selected.faithfulPlayed).toEqual(heard.faithfulPlayed);
  });

  it('infers the same rhythm metadata, because the audio is the same', () => {
    expect(selected.tempo).toEqual(heard.tempo);
    expect(selected.encodedBpm).toBe(heard.encodedBpm);
    expect(selected.versions).toEqual(heard.versions);
  });

  it('never reports the number that was selected', () => {
    // The specific failure: 120 appearing anywhere downstream of a take
    // performed at 85. Guarded loosely so an estimator improvement that moves
    // the reading a beat or two does not read as a regression.
    expect(heard.tempo.freeTiming).toBe(false);
    expect(Math.abs((heard.tempo.bpm as number) - REPORTED_SELECTED_BPM)).toBeGreaterThan(10);
    for (const version of heard.versions) {
      expect(version.bpm).not.toBe(REPORTED_SELECTED_BPM);
    }
  });

  it('preserves the absolute performance timing it was given', () => {
    // Faithful is not allowed to move a note onto a grid. Retouch runs at 0.15
    // timing strength there, so this checks the notes still sit where the Judge
    // put them rather than where a bar line would want them.
    const originals = heard.faithfulNotes.map((note: NoteEvent) => note.startSec);
    const played = heard.faithfulPlayed.map((note: NoteEvent) => note.startSec);
    expect(played.length).toBe(originals.length);
    for (let index = 0; index < played.length; index += 1) {
      expect(Math.abs((played[index] as number) - (originals[index] as number))).toBeLessThan(0.08);
    }
  });
});
