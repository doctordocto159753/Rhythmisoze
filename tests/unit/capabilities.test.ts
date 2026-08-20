/**
 * Regression tests for the "this browser cannot run Rhythmisoze" panel.
 *
 * The bug these lock down was reported from a real browser: opening the app
 * from a LAN address over plain HTTP produced "Missing: microphone access, Web
 * Audio, audio recording, offline audio rendering" on a completely modern
 * Chrome. Two separate faults produced it — an insecure origin removing
 * `getUserMedia`, and the pre-measurement snapshot being rendered as though it
 * were a result.
 */

import { describe, expect, it } from 'vitest';
import { assessCoreSupport, type Capabilities } from '@audio-core';

/** A modern, capable browser on an HTTPS origin. */
const CAPABLE: Capabilities = {
  secureContext: true,
  microphone: true,
  webAudio: true,
  mediaRecorder: true,
  recordingMimeType: 'audio/webm;codecs=opus',
  offlineAudio: true,
  webWorker: true,
  indexedDb: true,
  webAssembly: true,
  webgl2: true,
  cacheStorage: true,
  deviceMemoryGb: 8,
  hardwareConcurrency: 8,
  prefersReducedMotion: false,
  coarsePointer: false,
};

describe('assessCoreSupport', () => {
  it('accepts a capable browser on a secure origin', () => {
    const result = assessCoreSupport(CAPABLE);
    expect(result.supported).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.missing).toEqual([]);
  });

  it('blames the connection, not the browser, on an insecure origin', () => {
    // Exactly what Chrome reports over plain HTTP on a LAN address: the secure
    // context is gone and `navigator.mediaDevices` with it, while Web Audio,
    // MediaRecorder and OfflineAudioContext all still work.
    const result = assessCoreSupport({
      ...CAPABLE,
      secureContext: false,
      microphone: false,
      cacheStorage: false,
    });

    expect(result.supported).toBe(false);
    expect(result.reason).toBe('insecure_context');
    // The regression: it must NOT claim Web Audio, recording and offline
    // rendering are missing. They are not.
    expect(result.missing).toEqual([]);
  });

  it('still reports genuinely missing features on an insecure origin', () => {
    const result = assessCoreSupport({
      ...CAPABLE,
      secureContext: false,
      microphone: false,
      webAudio: false,
    });
    expect(result.reason).toBe('missing_features');
    expect(result.missing).toContain('webAudio');
    expect(result.missing).not.toContain('microphone');
  });

  it('reports a genuinely old browser as unsupported', () => {
    const result = assessCoreSupport({
      ...CAPABLE,
      mediaRecorder: false,
      offlineAudio: false,
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toBe('missing_features');
    expect(result.missing).toEqual(['mediaRecorder', 'offlineAudio']);
  });

  it('does not treat a secure browser missing the microphone as an origin problem', () => {
    // A locked-down enterprise build with getUserMedia removed, over HTTPS.
    const result = assessCoreSupport({ ...CAPABLE, microphone: false });
    expect(result.reason).toBe('missing_features');
    expect(result.missing).toEqual(['microphone']);
  });
});
