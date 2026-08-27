/**
 * Uncompressed capture, and what happens when it is not available.
 *
 * The reason this path exists is that `MediaRecorder` encodes to Opus on every
 * browser and offers no way to decline. A psychoacoustic coder is allowed to
 * discard whatever a listener will not notice, and a pitch model is not a
 * listener — so a hum recorded in the app arrived at the transcriber already
 * damaged, while the same performance uploaded as a file did not.
 *
 * There is no `AudioWorklet` in Node, so what is testable here is the half that
 * decides *whether* to use it. That half is worth pinning: the failure mode of
 * getting it wrong is not an exception, it is a silently worse recording.
 */

import { describe, expect, it } from 'vitest';
import { ensurePcmCaptureModule, isPcmCaptureReady } from '@audio-core';

/** The smallest thing that satisfies the parts of `BaseAudioContext` used here. */
function contextWithWorklet(addModule: (url: string) => Promise<void>): BaseAudioContext {
  return { audioWorklet: { addModule } } as unknown as BaseAudioContext;
}

describe('ensurePcmCaptureModule', () => {
  it('reports unavailable rather than throwing when the browser has no AudioWorklet', async () => {
    // Older Safari. The recorder must fall back, not fail: losing the take
    // because the better path was missing would be the wrong trade.
    const context = {} as unknown as BaseAudioContext;

    await expect(ensurePcmCaptureModule(context)).resolves.toBe(false);
    expect(isPcmCaptureReady(context)).toBe(false);
  });

  it('reports unavailable when the module is refused', async () => {
    // A strict Content-Security-Policy can reject the blob URL the processor is
    // loaded from. Same requirement: degrade to the encoder, keep recording.
    const context = contextWithWorklet(() => Promise.reject(new Error('blocked by CSP')));

    await expect(ensurePcmCaptureModule(context)).resolves.toBe(false);
    expect(isPcmCaptureReady(context)).toBe(false);
  });

  it('registers once and reports ready afterwards', async () => {
    const calls: string[] = [];
    const context = contextWithWorklet(async (url) => {
      calls.push(url);
    });

    expect(await ensurePcmCaptureModule(context)).toBe(true);
    expect(isPcmCaptureReady(context)).toBe(true);

    // `unlockAudio` runs before every recording, and registration is a property
    // of the context rather than of the take.
    expect(await ensurePcmCaptureModule(context)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('loads a processor that registers under the name the recorder asks for', async () => {
    let source = '';
    const context = contextWithWorklet(async (url) => {
      source = url;
    });
    const seen: string[] = [];
    const originalCreate = URL.createObjectURL;
    // Read what would have been served, rather than asserting on a blob: URL
    // that says nothing about its contents.
    URL.createObjectURL = ((blob: Blob) => {
      void blob.text().then((text) => seen.push(text));
      return 'blob:stub';
    }) as typeof URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

    try {
      await ensurePcmCaptureModule(context);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }

    expect(source).toBe('blob:stub');
    expect(seen[0]).toContain("registerProcessor('rhythmisoze-pcm-capture'");
    // The processor must copy samples out rather than post the frame it was
    // handed: the audio thread reuses that buffer.
    expect(seen[0]).toContain('this.buffer.slice(0, this.filled)');
  });
});
