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
  'tempo_ready',
  'armed',
  'countdown',
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
  'TEMPO_SET',
  'MODE_CHANGED',
  'ARM',
  'DISARM',
  'COUNT_IN_STARTED',
  'RECORDING_STARTED',
  'RECORDING_STOPPED',
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

/** The path a first-time user takes from landing to a published link. */
const HAPPY_PATH: CreationEvent[] = [
  'TEMPO_SET',
  'ARM',
  'COUNT_IN_STARTED',
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
      'tempo_ready',
      'armed',
      'countdown',
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
  it('cannot record before a tempo exists', () => {
    expect(transition(INITIAL_CONTEXT, 'RECORDING_STARTED').accepted).toBe(false);
    expect(transition(INITIAL_CONTEXT, 'ARM').accepted).toBe(false);
  });

  it('cannot publish before a render exists', () => {
    const review = run(['TEMPO_SET', 'ARM', 'COUNT_IN_STARTED', 'RECORDING_STARTED', 'RECORDING_STOPPED', 'PROCESS', 'PROCESS_DONE']);
    expect(review.state).toBe('review');
    expect(transition(review, 'PUBLISH').accepted).toBe(false);
  });

  it('cannot process without a capture', () => {
    const armed = run(['TEMPO_SET', 'ARM']);
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
    const context = run(['TEMPO_SET']);
    const result = transition(context, 'PUBLISH_DONE');
    expect(result.accepted).toBe(false);
    expect(result.context).toBe(context);
  });
});

describe('cancellation', () => {
  it('returns to armed from the count-in, not to the beginning', () => {
    const counting = run(['TEMPO_SET', 'ARM', 'COUNT_IN_STARTED']);
    expect(transition(counting, 'CANCEL').context.state).toBe('armed');
  });

  it('returns to armed from recording', () => {
    const recording = run(['TEMPO_SET', 'ARM', 'COUNT_IN_STARTED', 'RECORDING_STARTED']);
    expect(transition(recording, 'CANCEL').context.state).toBe('armed');
  });

  it('keeps the capture when processing is cancelled', () => {
    const processing = run([...HAPPY_PATH.slice(0, 6)]);
    expect(processing.state).toBe('processing');
    expect(transition(processing, 'CANCEL').context.state).toBe('captured');
  });
});

describe('failure and retry', () => {
  it('records where it failed', () => {
    const processing = run(HAPPY_PATH.slice(0, 6));
    const failed = transition(processing, 'FAIL', {
      code: 'model_load_failed',
      recovery: 'retry',
    }).context;
    expect(failed.state).toBe('failed');
    expect(failed.failedFrom).toBe('processing');
    expect(failed.error?.code).toBe('model_load_failed');
  });

  it('retrying a processing failure keeps the take rather than re-recording', () => {
    const processing = run(HAPPY_PATH.slice(0, 6));
    const failed = transition(processing, 'FAIL').context;
    expect(transition(failed, 'RETRY').context.state).toBe('captured');
  });

  it('retrying a publish failure returns to the finished render', () => {
    const publishing = run(HAPPY_PATH.slice(0, 10));
    expect(publishing.state).toBe('publishing');
    const failed = transition(publishing, 'FAIL').context;
    expect(transition(failed, 'RETRY').context.state).toBe('ready');
  });

  it('retrying a render failure returns to review, not to recording', () => {
    const rendering = run(HAPPY_PATH.slice(0, 8));
    const failed = transition(rendering, 'FAIL').context;
    expect(transition(failed, 'RETRY').context.state).toBe('review');
  });

  it('cannot fail twice or retry from a healthy state', () => {
    const failed = transition(run(['TEMPO_SET']), 'FAIL').context;
    expect(transition(failed, 'FAIL').accepted).toBe(false);
    expect(transition(run(['TEMPO_SET']), 'RETRY').accepted).toBe(false);
  });

  it('clears the error once it moves on', () => {
    const failed = transition(run(['TEMPO_SET']), 'FAIL').context;
    const recovered = transition(failed, 'RESET').context;
    expect(recovered.error).toBeNull();
    expect(recovered.failedFrom).toBeNull();
  });
});

describe('iteration (US-0704)', () => {
  it('can re-record from review, ready and published', () => {
    for (const upto of [7, 9, 11]) {
      const context = run(HAPPY_PATH.slice(0, upto));
      expect(transition(context, 'RERECORD').context.state).toBe('armed');
    }
  });

  it('re-entering review from ready when cleanup changes', () => {
    const ready = run(HAPPY_PATH.slice(0, 9));
    expect(ready.state).toBe('ready');
    expect(transition(ready, 'RETOUCH_CHANGED').context.state).toBe('review');
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

  it('gives every state a stage', () => {
    for (const state of ALL_STATES) {
      expect(['setup', 'record', 'process', 'shape', 'share']).toContain(stageOf(state));
    }
  });

  it('reports RETRY as available only from a failure with a memory', () => {
    const failed = transition(run(['TEMPO_SET']), 'FAIL').context;
    expect(allowedEvents(failed)).toContain('RETRY');
    expect(allowedEvents(run(['TEMPO_SET']))).not.toContain('RETRY');
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
