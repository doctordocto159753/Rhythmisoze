/**
 * US-0205 / US-0206 / US-0207 - microphone capture.
 *
 * ## Capture constraints
 *
 * `echoCancellation`, `noiseSuppression` and `autoGainControl` are all requested
 * *off*. They are tuned for speech intelligibility on a call, and each of them
 * damages exactly what this product needs: the noise suppressor gates the tail
 * of a sustained hum, AGC pumps the level mid-phrase and destroys the dynamics
 * the velocity mapping reads, and echo cancellation applies a filter that moves
 * the pitch tracker around. Browsers are free to ignore the request, which is
 * why `getSettings()` is recorded on the result - see
 * `docs/benchmarks/capture-constraints.md`.
 *
 * ## Privacy
 *
 * Nothing here uploads anything. The stream goes to a `MediaRecorder` and the
 * chunks stay in memory until the user exports or publishes (PRD 8, Playbook 16).
 */

import { AppError } from '@contracts';
import { pickRecordingMimeType } from './capabilities';

export const MUSIC_CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 44100,
};

export interface CaptureStream {
  stream: MediaStream;
  /** What the browser actually granted, which is often not what was asked for. */
  settings: MediaTrackSettings;
}

/**
 * Opens the microphone. Only ever called from a user gesture - the permission
 * prompt appearing on page load is the fastest way to get denied forever.
 */
export async function openMicrophone(): Promise<CaptureStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new AppError('mic_unavailable', 'none', 'getUserMedia missing');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: MUSIC_CAPTURE_CONSTRAINTS,
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    return { stream, settings: track?.getSettings() ?? {} };
  } catch (error) {
    throw mapGetUserMediaError(error);
  }
}

function mapGetUserMediaError(error: unknown): AppError {
  const name = error instanceof Error ? error.name : 'UnknownError';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new AppError('mic_permission_denied', 'check_permissions', name, { cause: error });
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new AppError('mic_unavailable', 'check_permissions', name, { cause: error });
    case 'NotReadableError':
    case 'AbortError':
      return new AppError('mic_in_use', 'retry', name, { cause: error });
    default:
      return new AppError('recording_failed', 'retry', name, { cause: error });
  }
}

export interface RecorderOptions {
  /** Hard cap on take length. Stops the recorder rather than trusting the UI. */
  maxDurationSec: number;
  /**
   * Context time at which the take is considered to begin.
   *
   * Existed for the count-in, which is gone: capture now starts when the
   * microphone opens, so callers leave this unset and the take begins where the
   * recorder does. Kept because "the take starts later than the stream" is a
   * real distinction a caller may need again, and it costs one optional field.
   */
  startAtSec?: number;
  onLevel?: (level: LevelSnapshot) => void;
  onDurationChange?: (seconds: number) => void;
  onAutoStop?: () => void;
}

export interface LevelSnapshot {
  /** Smoothed RMS, 0..1. Drives the live level meter. */
  rms: number;
  peak: number;
  /** True while the input is at or over full scale. */
  clipping: boolean;
  /** 128 downsampled points for the live waveform. */
  waveform: Float32Array;
}

export interface ActiveRecording {
  stop(): Promise<Blob>;
  cancel(): void;
  readonly mimeType: string;
}

/**
 * Starts recording and level analysis.
 *
 * The analyser runs on the same `MediaStream` rather than on recorder chunks so
 * the waveform is live rather than lagging a chunk behind. It reads at most 30
 * times a second: the visualisation must not compete with audio scheduling
 * (US-0207 acceptance criterion).
 */
export function startRecording(
  context: AudioContext,
  capture: CaptureStream,
  options: RecorderOptions,
): ActiveRecording {
  const mimeType = pickRecordingMimeType();
  if (mimeType === null) {
    throw new AppError('recording_failed', 'reload', 'MediaRecorder unavailable');
  }

  const chunks: BlobPart[] = [];
  const recorder =
    mimeType === '' ? new MediaRecorder(capture.stream) : new MediaRecorder(capture.stream, { mimeType });

  const source = context.createMediaStreamSource(capture.stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);
  const startedAt = context.currentTime;
  let frameHandle = 0;
  let lastLevelAt = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    frameHandle = requestAnimationFrame(tick);

    const now = context.currentTime;
    const elapsed = now - startedAt;
    options.onDurationChange?.(elapsed);

    if (elapsed >= options.maxDurationSec) {
      options.onAutoStop?.();
      return;
    }
    // Throttled to ~30 Hz regardless of display refresh rate.
    if (now - lastLevelAt < 1 / 30) return;
    lastLevelAt = now;

    analyser.getFloatTimeDomainData(buffer);
    options.onLevel?.(summarizeLevel(buffer));
  };

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      reject(new AppError('recording_failed', 'retry', 'MediaRecorder error'));
    };
    recorder.onstop = () => {
      // An empty blob means the browser produced no media at all; saving it
      // would create a sketch that can never be decoded.
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size === 0) reject(new AppError('recording_failed', 'rerecord', 'empty capture'));
      else resolve(blob);
    };
  });

  // 250 ms timeslices, so a tab crash loses at most a quarter second.
  recorder.start(250);
  frameHandle = requestAnimationFrame(tick);

  const teardown = (): void => {
    stopped = true;
    cancelAnimationFrame(frameHandle);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      // Already torn down by a context close; nothing to recover.
    }
  };

  return {
    mimeType: recorder.mimeType || mimeType || 'audio/webm',
    async stop() {
      teardown();
      if (recorder.state !== 'inactive') recorder.stop();
      return finished;
    },
    cancel() {
      teardown();
      chunks.length = 0;
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}

/** Reduces a time-domain frame to what the meter and waveform need. */
export function summarizeLevel(buffer: Float32Array, points = 128): LevelSnapshot {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i] as number;
    sumSquares += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }

  const stride = Math.max(1, Math.floor(buffer.length / points));
  const waveform = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    let localPeak = 0;
    const start = i * stride;
    for (let j = start; j < Math.min(start + stride, buffer.length); j += 1) {
      const magnitude = Math.abs(buffer[j] as number);
      if (magnitude > localPeak) localPeak = magnitude;
    }
    waveform[i] = localPeak;
  }

  return {
    rms: Math.sqrt(sumSquares / buffer.length),
    peak,
    clipping: peak >= 0.99,
    waveform,
  };
}

/** Stops every track. Leaving one open keeps the browser's recording indicator lit. */
export function closeMicrophone(capture: CaptureStream): void {
  for (const track of capture.stream.getTracks()) track.stop();
}
