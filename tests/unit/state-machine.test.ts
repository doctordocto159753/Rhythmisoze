/**
 * US-0104 - "invalid transitions are rejected in tests".
 *
 * Read literally: the interesting assertions here are the ones about events
 * that must *not* be accepted, and about failure never costing the user their
 * take.
 */

import { describe, expect, it } from 'vitest';
import {
  allowedEvents,
  canExport,
  hasResult,
  hasTake,
  INITIAL_CONTEXT,
  isBusy,
  isRecordingPhase,
  run,
  stageOf,
  transition,
  type CreationEvent,
  type CreationState,
} from '@/features/state/machine';

const ALL_STATES: CreationState[] = [
  'idle',
  'armed',
  'recording',
  'captured',
  'processing',
  'review',
  'rendering',
  'ready',
  'publishing',
  'published',
  'failed',
];

const ALL_EVENTS: CreationEvent[] = [
  'MODE_CHANGED',
  'ARM',
  'DISARM',
  'RECORDING_STARTED',
  'RECORDING_STOPPED',
  'AUDIO_IMPORTED',
  'MIDI_IMPORTED',
  'CANCEL',
  'PROCESS',
  'PROCESS_DONE',
  'RETOUCH_CHANGED',
  'RENDER',
  'RENDER_DONE',
  'RERECORD',
  'PUBLISH',
  'PUBLISH_DONE',
  'UNPUBLISH',
  'FAIL',
  'RETRY',
  'RESET',
  'RESTORE',
];

/**
 * The path a first-time user takes from landing to a published link.
 *
 * Two steps shorter than it was. `TEMPO_SET` used to be the first thing that
 * had to happen before anything else was legal, and `COUNT_IN_STARTED` sat
 * between arming and capture. Neither exists: the app opens on the record
 * control, and capture begins when the microphone does.
 */
const HAPPY_PATH: CreationEvent[] = [
  'ARM',
  'RECORDING_STARTED',
  'RECORDING_STOPPED',
  'PROCESS',
  'PROCESS_DONE',
  'RENDER',
  'RENDER_DONE',
  'PUBLISH',
  'PUBLISH_DONE',
];

describe('happy path', () => {
  it('reaches published', () => {
    expect(run(HAPPY_PATH).state).toBe('published');
  });

  it('accepts every step of it', () => {
    let context = INITIAL_CONTEXT;
    for (const event of HAPPY_PATH) {
      const result = transition(context, event);
      expect({ event, accepted: result.accepted }).toEqual({ event, accepted: true });
      context = result.context;
    }
  });

  it('passes through each expected state in order', () => {
    const seen: CreationState[] = [INITIAL_CONTEXT.state];
    let context = INITIAL_CONTEXT;
    for (const event of HAPPY_PATH) {
      context = transition(context, event).context;
      seen.push(context.state);
    }
    expect(seen).toEqual([
      'idle',
      'armed',
      'recording',
      'captured',
      'processing',
      'review',
      'rendering',
      'ready',
      'publishing',
      'published',
    ]);
  });
});

describe('invalid transitions', () => {
  it('arms straight from idle, with nothing to configure first', () => {
    // The inverse of the assertion that used to be here. Recording before a
    // tempo existed was illegal; there is no tempo to exist, so the only thing
    // standing between the app opening and a take is the microphone.
    expect(transition(INITIAL_CONTEXT, 'ARM').accepted).toBe(true);
  });

  it('cannot capture before the microphone is open', () => {
    expect(transition(INITIAL_CONTEXT, 'RECORDING_STARTED').accepted).toBe(false);
  });

  it('cannot publish before a render exists', () => {
    const review = run(['ARM', 'RECORDING_STARTED', 'RECORDING_STOPPED', 'PROCESS', 'PROCESS_DONE']);
    expect(review.state).toBe('review');
    expect(transition(review, 'PUBLISH').accepted).toBe(false);
  });

  it('cannot process without a capture', () => {
    const armed = run(['ARM']);
    expect(transition(armed, 'PROCESS').accepted).toBe(false);
  });

  it('never leaves the declared state set, whatever the event', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const result = transition({ state, failedFrom: 'processing', error: null }, event);
        expect(ALL_STATES).toContain(result.context.state);
      }
    }
  });

  it('leaves the context untouched when an event is rejected', () => {
    const context = run(['ARM']);
    const result = transition(context, 'PUBLISH_DONE');
    expect(result.accepted).toBe(false);
    expect(result.context).toBe(context);
  });
});

describe('cancellation', () => {
  it('returns to the top from recording', () => {
    // It used to return to `armed`, which was a distinct place to stand: the
    // microphone was open and a count-in was waiting to be triggered. Arming
    // now means recording, so cancelling a take leaves nothing in between.
    const recording = run(['ARM', 'RECORDING_STARTED']);
    expect(transition(recording, 'CANCEL').context.state).toBe('idle');
  });

  it('keeps the capture when processing is cancelled', () => {
    const processing = run([...HAPPY_PATH.slice(0, 4)]);
    expect(processing.state).toBe('processing');
    expect(transition(processing, 'CANCEL').context.state).toBe('captured');
  });
});

describe('failure and retry', () => {
  it('records where it failed', () => {
    const processing = run(HAPPY_PATH.slice(0, 4));
    const failed = transition(processing, 'FAIL', {
      code: 'model_load_failed',
      recovery: 'retry',
    }).context;
    expect(failed.state).toBe('failed');
    expect(failed.failedFrom).toBe('processing');
    expect(failed.error?.code).toBe('model_load_failed');
  });

  it('retrying a processing failure keeps the take rather than re-recording', () => {
    const processing = run(HAPPY_PATH.slice(0, 4));
    const failed = transition(processing, 'FAIL').context;
    expect(transition(failed, 'RETRY').context.state).toBe('captured');
  });

  it('returns to the start screen after a recoverable file-import failure', () => {
    const failed = transition(INITIAL_CONTEXT, 'FAIL', {
      code: 'unsupported_file',
      recovery: 'retry',
    }).context;

    // Nothing was configured, so there is nothing to preserve: the start screen
    // is both where the failure happened and where the next attempt begins.
    expect(transition(failed, 'RETRY').context.state).toBe('idle');
  });

  it('retrying a publish failure returns to the finished render', () => {
    const publishing = run(HAPPY_PATH.slice(0, 8));
    expect(publishing.state).toBe('publishing');
    const failed = transition(publishing, 'FAIL').context;
    expect(transition(failed, 'RETRY').context.state).toBe('ready');
  });

  it('retrying a render failure returns to review, not to recording', () => {
    const rendering = run(HAPPY_PATH.slice(0, 6));
    const failed = transition(rendering, 'FAIL').context;
    expect(transition(failed, 'RETRY').context.state).toBe('review');
  });

  it('cannot fail twice or retry from a healthy state', () => {
    const failed = transition(run(['ARM']), 'FAIL').context;
    expect(transition(failed, 'FAIL').accepted).toBe(false);
    expect(transition(run(['ARM']), 'RETRY').accepted).toBe(false);
  });

  it('clears the error once it moves on', () => {
    const failed = transition(run(['ARM']), 'FAIL').context;
    const recovered = transition(failed, 'RESET').context;
    expect(recovered.error).toBeNull();
    expect(recovered.failedFrom).toBeNull();
  });
});

describe('iteration (US-0704)', () => {
  it('can re-record from review, ready and published', () => {
    for (const upto of [5, 7, 9]) {
      const context = run(HAPPY_PATH.slice(0, upto));
      expect(transition(context, 'RERECORD').context.state).toBe('armed');
    }
  });

  it('re-entering review from ready when cleanup changes', () => {
    const ready = run(HAPPY_PATH.slice(0, 7));
    expect(ready.state).toBe('ready');
    expect(transition(ready, 'RETOUCH_CHANGED').context.state).toBe('review');
  });

  it('can reprocess the same source after a route correction', () => {
    for (const upto of [5, 7, 9]) {
      const context = run(HAPPY_PATH.slice(0, upto));
      const corrected = transition(context, 'PROCESS');
      expect({ state: context.state, accepted: corrected.accepted }).toEqual({
        state: context.state,
        accepted: true,
      });
      expect(corrected.context.state).toBe('processing');
    }
  });

  it('can reinterpret imported MIDI from review, ready or published', () => {
    for (const upto of [5, 7, 9]) {
      const context = run(HAPPY_PATH.slice(0, upto));
      const corrected = transition(context, 'MIDI_IMPORTED');
      expect(corrected.accepted).toBe(true);
      expect(corrected.context.state).toBe('review');
    }
  });

  it('restores a saved sketch straight into review', () => {
    expect(transition(INITIAL_CONTEXT, 'RESTORE').context.state).toBe('review');
  });

  it('unpublishing returns to a locally finished sketch', () => {
    const published = run(HAPPY_PATH);
    expect(transition(published, 'UNPUBLISH').context.state).toBe('ready');
  });
});

describe('derived predicates', () => {
  it('classifies each state consistently', () => {
    expect(isRecordingPhase('recording')).toBe(true);
    expect(isRecordingPhase('review')).toBe(false);
    expect(isBusy('processing')).toBe(true);
    expect(isBusy('review')).toBe(false);
    expect(hasTake('captured')).toBe(true);
    expect(hasTake('armed')).toBe(false);
    expect(hasResult('review')).toBe(true);
    expect(hasResult('captured')).toBe(false);
    expect(canExport('ready')).toBe(true);
    expect(canExport('review')).toBe(false);
  });

  it('gives every state a stage, and none of them a setup stage', () => {
    for (const state of ALL_STATES) {
      expect(['record', 'process', 'shape', 'share']).toContain(stageOf(state));
    }
    // The first thing the product asks for is the material itself, so an
    // untouched app is already in the record stage rather than before it.
    expect(stageOf('idle')).toBe('record');
  });

  it('reports RETRY as available only from a failure with a memory', () => {
    const failed = transition(run(['ARM']), 'FAIL').context;
    expect(allowedEvents(failed)).toContain('RETRY');
    expect(allowedEvents(run(['ARM']))).not.toContain('RETRY');
  });
});

describe('reachability', () => {
  it('reaches every state from idle', () => {
    const reached = new Set<CreationState>(['idle']);
    const queue: CreationState[] = ['idle'];
    while (queue.length > 0) {
      const state = queue.shift() as CreationState;
      for (const event of ALL_EVENTS) {
        const result = transition({ state, failedFrom: state, error: null }, event);
        if (result.accepted && !reached.has(result.context.state)) {
          reached.add(result.context.state);
          queue.push(result.context.state);
        }
      }
    }
    for (const state of ALL_STATES) expect([...reached]).toContain(state);
  });

  it('always has a way back to idle', () => {
    for (const state of ALL_STATES) {
      const result = transition({ state, failedFrom: null, error: null }, 'RESET');
      expect(result.context.state).toBe('idle');
    }
  });
});
