/**
 * US-0104 - the creation state machine.
 *
 * "Do not coordinate the product through unrelated booleans" (Playbook 10.3).
 * One state, one transition table, and every screen derives what it shows from
 * it. The table is data rather than a switch statement so an invalid transition
 * is a lookup miss instead of a forgotten branch, and so the test can assert the
 * whole reachability graph rather than the paths somebody remembered to write.
 *
 * Failure is a state with a memory: `failed` records where it came from, so
 * "try again" returns to the step that broke rather than to the beginning. That
 * is the difference between a recoverable error and a lost take.
 *
 * ## What the tempo removal took out of here
 *
 * `tempo_ready` and `countdown` are gone, along with `TEMPO_SET` and
 * `COUNT_IN_STARTED`. They encoded a premise the product no longer holds — that
 * a person must establish a tempo before they are allowed to make a sound, and
 * then perform against a click. `idle` now accepts `ARM` directly, so the first
 * screen offers recording and uploading and nothing else.
 */

import type { AppErrorCode, RecoveryAction } from '@contracts';

export type CreationState =
  | 'idle'
  | 'armed'
  | 'recording'
  | 'captured'
  | 'processing'
  | 'review'
  | 'rendering'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'failed';

export type CreationEvent =
  | 'MODE_CHANGED'
  | 'ARM'
  | 'DISARM'
  | 'RECORDING_STARTED'
  | 'RECORDING_STOPPED'
  | 'AUDIO_IMPORTED'
  | 'MIDI_IMPORTED'
  | 'CANCEL'
  | 'PROCESS'
  | 'PROCESS_DONE'
  | 'RETOUCH_CHANGED'
  | 'RENDER'
  | 'RENDER_DONE'
  | 'RERECORD'
  | 'PUBLISH'
  | 'PUBLISH_DONE'
  | 'UNPUBLISH'
  | 'FAIL'
  | 'RETRY'
  | 'RESET'
  | 'RESTORE';

/**
 * Every legal transition. Anything absent is rejected, which is the point.
 *
 * `FAIL` and `RETRY` are handled outside the table because they apply from
 * almost anywhere and need to carry the state they came from.
 */
const TRANSITIONS: Readonly<Record<CreationState, Partial<Record<CreationEvent, CreationState>>>> =
  Object.freeze({
    idle: {
      MODE_CHANGED: 'idle',
      ARM: 'armed',
      AUDIO_IMPORTED: 'captured',
      MIDI_IMPORTED: 'review',
      RESTORE: 'review',
      RESET: 'idle',
    },
    armed: {
      // Recording begins as soon as the microphone is open. There is no
      // count-in to wait through, because there is no click to come in against.
      RECORDING_STARTED: 'recording',
      DISARM: 'idle',
      MODE_CHANGED: 'idle',
      AUDIO_IMPORTED: 'captured',
      MIDI_IMPORTED: 'review',
      CANCEL: 'idle',
      RESET: 'idle',
    },
    recording: {
      RECORDING_STOPPED: 'captured',
      CANCEL: 'idle',
      RESET: 'idle',
    },
    captured: {
      PROCESS: 'processing',
      RERECORD: 'armed',
      RESET: 'idle',
    },
    processing: {
      PROCESS_DONE: 'review',
      CANCEL: 'captured',
      RESET: 'idle',
    },
    review: {
      PROCESS: 'processing',
      MIDI_IMPORTED: 'review',
      RETOUCH_CHANGED: 'review',
      RENDER: 'rendering',
      RERECORD: 'armed',
      RESET: 'idle',
    },
    rendering: {
      RENDER_DONE: 'ready',
      CANCEL: 'review',
      RESET: 'idle',
    },
    ready: {
      PROCESS: 'processing',
      MIDI_IMPORTED: 'review',
      RETOUCH_CHANGED: 'review',
      RENDER: 'rendering',
      PUBLISH: 'publishing',
      RERECORD: 'armed',
      RESET: 'idle',
    },
    publishing: {
      PUBLISH_DONE: 'published',
      CANCEL: 'ready',
      RESET: 'idle',
    },
    published: {
      PROCESS: 'processing',
      MIDI_IMPORTED: 'review',
      UNPUBLISH: 'ready',
      RETOUCH_CHANGED: 'review',
      RERECORD: 'armed',
      RESET: 'idle',
    },
    failed: {
      RESET: 'idle',
    },
  });

export interface MachineContext {
  state: CreationState;
  /** Where `failed` came from, so RETRY can return there. */
  failedFrom: CreationState | null;
  error: { code: AppErrorCode; recovery: RecoveryAction } | null;
}

export const INITIAL_CONTEXT: MachineContext = {
  state: 'idle',
  failedFrom: null,
  error: null,
};

export interface TransitionResult {
  context: MachineContext;
  /** `false` when the event was not legal from the current state. */
  accepted: boolean;
}

/**
 * States a failure can interrupt without losing the user's take.
 * A failure in `recording` drops back to the top; one in `processing` keeps the
 * capture so the user can retry without singing again (US-0305).
 */
const RETRY_TARGET: Readonly<Partial<Record<CreationState, CreationState>>> = Object.freeze({
  idle: 'idle',
  armed: 'idle',
  recording: 'idle',
  captured: 'captured',
  processing: 'captured',
  rendering: 'review',
  publishing: 'ready',
  review: 'review',
  ready: 'ready',
});

export function transition(
  context: MachineContext,
  event: CreationEvent,
  payload?: { code: AppErrorCode; recovery: RecoveryAction },
): TransitionResult {
  if (event === 'FAIL') {
    if (context.state === 'failed') return { context, accepted: false };
    return {
      context: {
        state: 'failed',
        failedFrom: context.state,
        error: payload ?? { code: 'unknown', recovery: 'retry' },
      },
      accepted: true,
    };
  }

  if (event === 'RETRY') {
    if (context.state !== 'failed' || context.failedFrom === null) {
      return { context, accepted: false };
    }
    const target = RETRY_TARGET[context.failedFrom] ?? 'idle';
    return { context: { state: target, failedFrom: null, error: null }, accepted: true };
  }

  const next = TRANSITIONS[context.state][event];
  if (next === undefined) return { context, accepted: false };
  return { context: { state: next, failedFrom: null, error: null }, accepted: true };
}

/** Convenience for tests and for driving a sequence in one call. */
export function run(events: readonly CreationEvent[], from = INITIAL_CONTEXT): MachineContext {
  return events.reduce((context, event) => transition(context, event).context, from);
}

/** Events legal right now. Drives which controls the UI enables. */
export function allowedEvents(context: MachineContext): CreationEvent[] {
  const base = Object.keys(TRANSITIONS[context.state]) as CreationEvent[];
  if (context.state === 'failed' && context.failedFrom !== null) return [...base, 'RETRY'];
  return [...base, 'FAIL'];
}

// --- Derived UI predicates. Every component reads these rather than comparing
// --- state strings, so adding a state does not mean auditing every screen.

export const isRecordingPhase = (s: CreationState): boolean => s === 'recording';

export const isBusy = (s: CreationState): boolean =>
  s === 'processing' || s === 'rendering' || s === 'publishing';

export const hasTake = (s: CreationState): boolean =>
  s === 'captured' ||
  s === 'processing' ||
  s === 'review' ||
  s === 'rendering' ||
  s === 'ready' ||
  s === 'publishing' ||
  s === 'published';

export const hasResult = (s: CreationState): boolean =>
  s === 'review' || s === 'rendering' || s === 'ready' || s === 'publishing' || s === 'published';

export const canExport = (s: CreationState): boolean => s === 'ready' || s === 'published';

/**
 * The stage label the progress indicator shows, coarse enough to stay honest.
 *
 * There is no `setup` stage any more. It existed to cover the tempo step, and
 * with that gone the first thing the product asks for is the material itself —
 * so an untouched app is already *in* the record stage rather than in front of
 * a gate before it.
 */
export function stageOf(state: CreationState): 'record' | 'process' | 'shape' | 'share' {
  switch (state) {
    case 'idle':
    case 'armed':
    case 'recording':
    case 'captured':
      return 'record';
    case 'processing':
      return 'process';
    case 'review':
    case 'rendering':
      return 'shape';
    case 'ready':
    case 'publishing':
    case 'published':
      return 'share';
    case 'failed':
      return 'process';
  }
}
