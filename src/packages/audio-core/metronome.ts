/**
 * US-0203 / US-0204 - low-drift metronome and one-bar count-in.
 *
 * The clicks are scheduled ahead of time on the Web Audio clock. A `setInterval`
 * metronome drifts by tens of milliseconds under any main-thread load, and the
 * whole product rests on the grid being trustworthy - if the click is late, the
 * user performs late, and the quantizer then "corrects" a perfectly good take
 * onto the wrong beat.
 *
 * The pattern is the standard lookahead scheduler: a timer that fires often but
 * does no audio work itself, and schedules every click that falls inside the
 * next window at an exact `AudioContext.currentTime` offset. Timer jitter moves
 * *when we schedule*, never *when it sounds*.
 *
 * Visual beats are reported through the same scheduled times so the pulse the
 * user sees and the click they hear come from one source (D-0302), and so the
 * count-in remains usable with sound muted (accessibility skill: never assume
 * the user hears the metronome).
 */

export interface BeatInfo {
  /** Beats since the scheduler started, from 0. */
  index: number;
  /** Position inside the bar, from 0. */
  beatInBar: number;
  /** True for the first beat of a bar. */
  isDownbeat: boolean;
  /** True while the count-in is running. */
  isCountIn: boolean;
  /** `AudioContext.currentTime` at which this beat sounds. */
  timeSec: number;
}

export interface MetronomeOptions {
  bpm: number;
  beatsPerBar: number;
  /** Bars of count-in before beat 0 of the take (PRD R-04: one measure). */
  countInBars: number;
  muted: boolean;
  /** How far ahead clicks are scheduled. 100 ms absorbs main-thread stalls. */
  scheduleAheadSec?: number;
  /** How often the scheduler wakes. Must be well under scheduleAheadSec. */
  lookaheadMs?: number;
}

export interface MetronomeHandle {
  stop(): void;
  setMuted(muted: boolean): void;
  /** `AudioContext.currentTime` at which the count-in ends and the take begins. */
  readonly startTimeSec: number;
}

const DEFAULT_SCHEDULE_AHEAD_SEC = 0.1;
const DEFAULT_LOOKAHEAD_MS = 25;

/**
 * Starts the metronome, including the count-in.
 *
 * `onBeat` fires from the lookahead timer *before* the beat sounds, and carries
 * the exact time it will sound. UI code is expected to defer its own visual
 * update to that timestamp rather than painting on the callback.
 */
export function startMetronome(
  context: AudioContext,
  destination: AudioNode,
  options: MetronomeOptions,
  onBeat: (beat: BeatInfo) => void,
): MetronomeHandle {
  const scheduleAhead = options.scheduleAheadSec ?? DEFAULT_SCHEDULE_AHEAD_SEC;
  const lookahead = options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
  const secondsPerBeat = 60 / options.bpm;
  const countInBeats = options.countInBars * options.beatsPerBar;

  // A short lead-in keeps the very first click from being scheduled in the past
  // on a context that has only just resumed.
  const originSec = context.currentTime + 0.12;
  const startTimeSec = originSec + countInBeats * secondsPerBeat;

  let muted = options.muted;
  let nextBeat = 0;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    while (originSec + nextBeat * secondsPerBeat < context.currentTime + scheduleAhead) {
      const timeSec = originSec + nextBeat * secondsPerBeat;
      const isCountIn = nextBeat < countInBeats;
      const beatInBar = nextBeat % options.beatsPerBar;
      const isDownbeat = beatInBar === 0;

      if (!muted) playClick(context, destination, timeSec, isDownbeat, isCountIn);
      onBeat({ index: nextBeat, beatInBar, isDownbeat, isCountIn, timeSec });
      nextBeat += 1;
    }
  };

  schedule();
  const timer = setInterval(schedule, lookahead);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    setMuted(next: boolean) {
      muted = next;
    },
    startTimeSec,
  };
}

/**
 * One click. Synthesised rather than sampled so it costs nothing to load and
 * cannot be late because a file was still fetching.
 *
 * Three timbres, because a count-in has to be distinguishable from the take by
 * ear alone: count-in beats are softer and duller, the downbeat is a fifth
 * above the offbeats.
 */
export function playClick(
  context: BaseAudioContext,
  destination: AudioNode,
  timeSec: number,
  isDownbeat: boolean,
  isCountIn: boolean,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(isDownbeat ? 1600 : 1050, timeSec);

  const level = isCountIn ? 0.14 : isDownbeat ? 0.26 : 0.18;
  const decay = isCountIn ? 0.035 : 0.045;

  // Short attack ramp instead of an instant jump: a hard step on a square wave
  // clicks in the DAC and reads as a glitch rather than a metronome.
  gain.gain.setValueAtTime(0.0001, timeSec);
  gain.gain.exponentialRampToValueAtTime(level, timeSec + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, timeSec + decay);

  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(timeSec);
  oscillator.stop(timeSec + decay + 0.02);
}

/**
 * Measures scheduling drift over a window of beats.
 * Used by `tests/unit/metronome.test.ts` to hold the tolerance recorded in
 * `docs/benchmarks/metronome-drift.md` rather than trusting the design.
 */
export function measureDrift(beatTimes: readonly number[], bpm: number): {
  maxDriftMs: number;
  meanDriftMs: number;
} {
  if (beatTimes.length < 2) return { maxDriftMs: 0, meanDriftMs: 0 };
  const expected = 60 / bpm;
  const origin = beatTimes[0] as number;
  let max = 0;
  let total = 0;
  for (let i = 1; i < beatTimes.length; i += 1) {
    const drift = Math.abs((beatTimes[i] as number) - (origin + i * expected)) * 1000;
    max = Math.max(max, drift);
    total += drift;
  }
  return { maxDriftMs: max, meanDriftMs: total / (beatTimes.length - 1) };
}
