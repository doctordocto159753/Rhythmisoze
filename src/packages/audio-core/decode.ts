/**
 * Decoding captured or uploaded media into the internal representation.
 *
 * Kept apart from `normalize.ts` because this half needs the browser and that
 * half does not - the pure functions stay unit-testable in Node.
 */

import { AppError, type MonoAudio } from '@contracts';
import { toMonoAudio, type AudioBufferLike } from './normalize';

/**
 * Decodes a recorded blob to mono float PCM.
 *
 * `decodeAudioData` is the only decoder guaranteed to understand whatever the
 * local `MediaRecorder` just produced, so it is used even though it requires an
 * `AudioContext`. Safari has historically failed on short or truncated clips
 * with a bare `EncodingError`; that maps to `decode_failed`, whose recovery
 * action is "record again" rather than "retry", because retrying the same
 * bytes will fail identically.
 */
export async function decodeToMono(blob: Blob, context: BaseAudioContext): Promise<MonoAudio> {
  let buffer: AudioBuffer;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    buffer = await context.decodeAudioData(arrayBuffer);
  } catch (error) {
    throw new AppError('decode_failed', 'rerecord', blob.type || 'unknown-type', { cause: error });
  }
  return toMonoAudio(buffer as unknown as AudioBufferLike);
}

/** Rebuilds a playable `AudioBuffer` from the internal representation. */
export function monoToAudioBuffer(audio: MonoAudio, context: BaseAudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate);
  // A fresh copy keeps the buffer type concrete: a Float32Array over a
  // SharedArrayBuffer is not assignable to copyToChannel.
  buffer.copyToChannel(new Float32Array(audio.samples), 0);
  return buffer;
}

/**
 * A shared `AudioContext`, created lazily on the first user gesture.
 *
 * Browsers start contexts suspended until a gesture, and creating one per
 * component leaks hardware audio graphs on iOS until the tab is closed.
 */
let sharedContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (typeof window === 'undefined') {
    throw new AppError('unsupported_browser', 'none', 'no window');
  }
  if (sharedContext === null || sharedContext.state === 'closed') {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new AppError('unsupported_browser', 'none', 'no AudioContext');
    sharedContext = new Ctor({ sampleRate: 44100 });
  }
  return sharedContext;
}

/** Resumes the shared context. Must be called from inside a user gesture. */
export async function unlockAudio(): Promise<AudioContext> {
  const context = getAudioContext();
  if (context.state === 'suspended') await context.resume();
  return context;
}

export async function closeAudioContext(): Promise<void> {
  if (sharedContext && sharedContext.state !== 'closed') await sharedContext.close();
  sharedContext = null;
}
