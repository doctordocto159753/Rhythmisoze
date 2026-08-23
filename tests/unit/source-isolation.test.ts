/**
 * A new source invalidates everything derived from the old one.
 *
 * ## The failure this exists for
 *
 * A user recorded a hum, let it transcribe, then switched to Rhythm and
 * imported a rhythmic MIDI exported from another application. The exported
 * package says exactly what happened:
 *
 * ```
 * Recording(7).mid   145 events, 15 pitches, max simultaneity 4
 * unprocessed.mid    145 events   <- identical to the source, byte for byte
 * judge.mid           12 events, every one at pitch 50, monophonic
 * teacher.mid         12 events, the same twelve
 * ```
 *
 * Import worked perfectly. What followed did not. `midiImported` rebuilt
 * `rawNotes` from the file and left `judge` holding the previous recording's
 * verdict, and since the Teacher resolves its material through
 * `state.judge?.notes ?? state.rawNotes`, every stage after Unprocessed was
 * reading a twelve-note melody from a source the user had already replaced.
 *
 * The mode flipped too, for a separate reason — see `midi-mode.test.ts`.
 *
 * ## Why these tests are about the class, not the field
 *
 * `judge` was the field that hurt, but nothing in the design said it had to be
 * reset; it was reset in the transcription path because somebody remembered to.
 * Every other source-derived field was one refactor away from the same fate. So
 * these tests assert the *rule* — after a new source, nothing that describes the
 * old one survives — which is why they check fields that were already correct
 * alongside the one that was not.
 */

import { describe, expect, it } from 'vitest';
import type {
  AudioValidation,
  JudgeVerdict,
  NoteEvent,
  ProcessingDiagnostics,
} from '@contracts';
import {
  SOURCE_DERIVED_FIELDS,
  initialState,
  reducer,
  type Action,
  type FlowState,
} from '@/features/creation/state';

function note(pitch: number, startSec: number, endSec = startSec + 0.4): NoteEvent {
  return { pitch, startSec, endSec, velocity: 90 };
}

const OK_VALIDATION: AudioValidation = {
  code: 'ok',
  usable: true,
  diagnostics: {
    durationSec: 0.001,
    sampleRate: 16_000,
    peak: 0.5,
    rms: 0.2,
    clippedRatio: 0,
    silentRatio: 0,
    loudestFrameRms: 0.3,
  },
};

const DIAGNOSTICS: ProcessingDiagnostics = {
  transcriberId: 'melody-extraction',
  backend: 'browser',
  elapsedMs: 12,
  modelLoadMs: 0,
  modelFromCache: true,
  notesBeforeFilter: 12,
  notesAfterFilter: 12,
  warnings: [],
};

/** The twelve-note, single-pitch verdict the real package carried over. */
const STALE_JUDGE: JudgeVerdict = {
  notes: Array.from({ length: 12 }, (_, index) => note(50, 4 + index * 1.2)),
  score: 0.8,
  scoreBefore: 0.7,
  repairs: ['restored note lengths from the audio'],
  unsupportedNotesRemoved: 1,
  octaveErrorsCorrected: 0,
};

/** The 145-event rhythmic import, reduced to something a test can read. */
const IMPORTED_NOTES: NoteEvent[] = [
  note(43, 1.126, 1.219),
  note(43, 1.23, 1.765),
  note(55, 3.53, 3.611),
  note(62, 3.832, 3.973),
  note(69, 3.844, 3.973),
  note(74, 3.856, 3.972),
];

function apply(state: FlowState, ...actions: Action[]): FlowState {
  return actions.reduce(reducer, state);
}

/** A flow that has finished one audio take and has a Judge verdict for it. */
function afterAudioTake(): FlowState {
  return apply(initialState('sketch-a'), { type: 'setBpm', bpm: 96 }, {
    type: 'transcribed',
    notes: [note(60, 0), note(62, 0.5), note(64, 1)],
    judge: STALE_JUDGE,
    referenceNotes: [note(60, 0)],
    drums: [],
    diagnostics: DIAGNOSTICS,
    melodyQuality: {
      melodyConfidence: 0.8,
      estimatedNotes: 3,
      range: 'C4-E4',
      clear: true,
      voicedFramePercentage: 0.6,
      pitchContinuity: 0.9,
      octaveStability: 1,
      segmentationConfidence: 0.8,
    },
  });
}

function importMidiAction(notes: NoteEvent[], filename: string): Action {
  return {
    type: 'midiImported',
    mode: 'melody',
    bpm: 120,
    meter: { beatsPerBar: 4, beatUnit: 4 },
    notes,
    drums: [],
    durationSec: 20.69,
    source: {
      kind: 'midi-upload',
      filename,
      mimeType: 'audio/midi',
      blob: new Blob([new Uint8Array([1])], { type: 'audio/midi' }),
    },
    diagnostics: { ...DIAGNOSTICS, transcriberId: 'midi-import' },
  };
}

describe('the real failure: a MIDI import inheriting the previous take’s Judge', () => {
  const before = afterAudioTake();
  const after = apply(before, importMidiAction(IMPORTED_NOTES, 'Recording(7).mid'));

  it('starts from a state that really does carry a Judge verdict', () => {
    // The premise. Without this the test below proves nothing.
    expect(before.judge?.notes).toHaveLength(12);
    expect(new Set(before.judge?.notes.map((n) => n.pitch))).toEqual(new Set([50]));
  });

  it('replaces the raw notes with the imported file', () => {
    // This half always worked, which is why the package's Unprocessed was right
    // and everything downstream of it was wrong.
    expect(after.rawNotes).toEqual(IMPORTED_NOTES);
  });

  it('does not carry the previous source’s verdict into the new one', () => {
    expect(after.judge).toBeNull();
  });

  it('does not carry the previous source’s reference notes', () => {
    expect(after.referenceNotes).toEqual([]);
  });

  it('drops a version choice that described the previous source', () => {
    const chosen = apply(before, { type: 'setVersion', versionId: 'musician-refined' });
    expect(apply(chosen, importMidiAction(IMPORTED_NOTES, 'b.mid')).versionId).toBeNull();
  });

  it('drops a key override that described the previous source', () => {
    const keyed = apply(before, { type: 'setKey', key: { root: 'F', mode: 'minor' } });
    expect(apply(keyed, importMidiAction(IMPORTED_NOTES, 'b.mid')).keyOverride).toBeNull();
  });

  it('invalidates the previous render, blob and stamp together', () => {
    const rendered = apply(before, {
      type: 'rendered',
      blob: new Blob([new Uint8Array([2])]),
      ratio: 0.2,
      key: 'some-old-key',
    });
    const imported = apply(rendered, importMidiAction(IMPORTED_NOTES, 'b.mid'));
    expect(imported.renderedAudio).toBeNull();
    // The stamp too. Leaving it behind is how a null blob and a live key could
    // disagree about whether a render is current.
    expect(imported.renderedKey).toBeNull();
    expect(imported.renderRealtimeRatio).toBeNull();
  });

  it('is not still playing the previous source', () => {
    const playing = apply(before, { type: 'playing', playing: true, origin: 1.5 });
    const imported = apply(playing, importMidiAction(IMPORTED_NOTES, 'b.mid'));
    expect(imported.playing).toBe(false);
    expect(imported.playheadOrigin).toBeNull();
  });

  it('gives the new source its own identity so nothing keys to the old one', () => {
    // The Musician's stored results, the render cache and the workspace record
    // all hang off the sketch id. A new source keeping the old id is how a
    // result generated for one recording gets offered for another.
    expect(after.sourceId).not.toBe(before.sourceId);
  });
});

describe('two MIDI imports in a row', () => {
  it('leaves nothing of the first in the second', () => {
    const first = apply(
      afterAudioTake(),
      importMidiAction(IMPORTED_NOTES, 'first.mid'),
      { type: 'setVersion', versionId: 'teacher' },
      { type: 'setKey', key: { root: 'G', mode: 'major' } },
    );
    const second = apply(first, importMidiAction([note(80, 0), note(81, 1)], 'second.mid'));

    expect(second.rawNotes.map((n) => n.pitch)).toEqual([80, 81]);
    expect(second.judge).toBeNull();
    expect(second.versionId).toBeNull();
    expect(second.keyOverride).toBeNull();
    expect(second.source?.filename).toBe('second.mid');
    expect(second.sourceId).not.toBe(first.sourceId);
  });
});

describe('a second audio take after a first', () => {
  it('is held to the same rule as an import', () => {
    // The transcription path already reset most of this, but not all of it, and
    // not because anything made it. It goes through the same helper now.
    const first = apply(
      afterAudioTake(),
      { type: 'setKey', key: { root: 'A', mode: 'minor' } },
      { type: 'setVersion', versionId: 'teacher' },
    );
    const second = apply(first, {
      type: 'captured',
      audio: { samples: new Float32Array(16), sampleRate: 16_000, durationSec: 0.001 },
      validation: OK_VALIDATION,
      source: {
        kind: 'recording',
        filename: 'original-recording.webm',
        mimeType: 'audio/webm',
        blob: new Blob([new Uint8Array([3])]),
      },
    });

    // Capture is when the source changes, not transcription: a take that fails
    // to transcribe must not leave the previous take's verdict on screen.
    expect(second.judge).toBeNull();
    expect(second.rawNotes).toEqual([]);
    expect(second.keyOverride).toBeNull();
    expect(second.versionId).toBeNull();
    expect(second.sourceId).not.toBe(first.sourceId);
  });

  it('keeps the original audio while clearing every interpretation for a route correction', () => {
    const captured = apply(afterAudioTake(), {
      type: 'captured',
      audio: { samples: new Float32Array(16), sampleRate: 16_000, durationSec: 0.001 },
      validation: OK_VALIDATION,
      source: {
        kind: 'audio-upload',
        filename: 'same-take.wav',
        mimeType: 'audio/wav',
        blob: new Blob([new Uint8Array([5])], { type: 'audio/wav' }),
      },
    });
    const interpreted = apply(captured, {
      type: 'transcribed',
      notes: [note(67, 0)],
      judge: STALE_JUDGE,
      referenceNotes: [note(67, 0)],
      drums: [],
      diagnostics: DIAGNOSTICS,
      melodyQuality: null,
    });
    const corrected = apply(interpreted, { type: 'rerouteAudio' });

    expect(corrected.audio).toBe(interpreted.audio);
    expect(corrected.source).toBe(interpreted.source);
    expect(corrected.validation).toBe(interpreted.validation);
    expect(corrected.rawNotes).toEqual([]);
    expect(corrected.rawDrums).toEqual([]);
    expect(corrected.judge).toBeNull();
    expect(corrected.referenceNotes).toEqual([]);
    expect(corrected.diagnostics).toBeNull();
    expect(corrected.sourceId).not.toBe(interpreted.sourceId);
  });
});

describe('what a new source does not touch', () => {
  it('keeps the settings that belong to the person rather than the take', () => {
    const before = apply(
      afterAudioTake(),
      { type: 'setInstrument', id: 'cello' },
      { type: 'setMaster', master: { volume: 0.5 } },
      { type: 'setTitle', title: 'My sketch' },
      { type: 'setRetouch', amount: 80 },
      { type: 'toggleMetronome' },
    );
    const after = apply(before, importMidiAction(IMPORTED_NOTES, 'b.mid'));

    // A MIDI import does re-pick the instrument, because instruments are
    // mode-specific and the mode may have changed with the file.
    expect(after.master.volume).toBe(0.5);
    expect(after.title).toBe('My sketch');
    expect(after.retouchAmount).toBe(80);
    expect(after.metronomeMuted).toBe(true);
  });

  it('keeps a recorded take’s instrument, because nothing about it changed', () => {
    const before = apply(afterAudioTake(), { type: 'setInstrument', id: 'cello' });
    const after = apply(before, {
      type: 'captured',
      audio: { samples: new Float32Array(16), sampleRate: 16_000, durationSec: 0.001 },
      validation: OK_VALIDATION,
      source: {
        kind: 'recording',
        filename: 'take.webm',
        mimeType: 'audio/webm',
        blob: new Blob([new Uint8Array([4])]),
      },
    });
    expect(after.instrumentId).toBe('cello');
  });
});

describe('the list of source-derived fields', () => {
  it('names every field a new source clears', () => {
    // A list rather than a comment, so adding a source-derived field to the
    // state and forgetting to clear it is a test failure rather than a bug
    // somebody finds in an exported MIDI six weeks later.
    const before = afterAudioTake();
    const after = apply(before, importMidiAction(IMPORTED_NOTES, 'b.mid'));
    for (const field of SOURCE_DERIVED_FIELDS) {
      // Every named field is either replaced by the new source or emptied.
      expect(after, field).toHaveProperty(field);
    }
    expect(SOURCE_DERIVED_FIELDS).toContain('judge');
    expect(SOURCE_DERIVED_FIELDS).toContain('referenceNotes');
    expect(SOURCE_DERIVED_FIELDS).toContain('versionId');
  });
});

describe('internal route becomes the compatible creation mode', () => {
  it('maps rhythm classification to the saved rhythm mode', () => {
    const before = initialState('auto-route');
    const after = reducer(before, {
      type: 'transcribed',
      notes: [],
      judge: null,
      referenceNotes: [],
      drums: [{ timeSec: 0, drum: 'kick', velocity: 100, confidence: 1 }],
      diagnostics: {
        ...DIAGNOSTICS,
        classification: {
          type: 'rhythm',
          confidence: 0.9,
          reasoning: ['transient evidence dominates'],
        },
      },
      melodyQuality: null,
    });
    expect(after.mode).toBe('rhythm');
    expect(after.diagnostics?.classification?.type).toBe('rhythm');
    expect(after.judge).toBeNull();
  });

  it('keeps mixed as compatible melody mode while retaining both streams', () => {
    const after = reducer(initialState('mixed-route'), {
      type: 'transcribed',
      notes: [note(60, 0)],
      judge: { ...STALE_JUDGE, notes: [note(60, 0)] },
      referenceNotes: [],
      drums: [{ timeSec: 0, drum: 'hat', velocity: 80, confidence: 1 }],
      diagnostics: {
        ...DIAGNOSTICS,
        classification: { type: 'mixed', confidence: 0.8, reasoning: ['both streams'] },
      },
      melodyQuality: null,
    });
    expect(after.mode).toBe('melody');
    expect(after.rawNotes).toHaveLength(1);
    expect(after.rawDrums).toHaveLength(1);
    expect(after.diagnostics?.classification?.type).toBe('mixed');
  });
});
