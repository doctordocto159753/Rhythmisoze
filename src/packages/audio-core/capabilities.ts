/**
 * US-0105 - centralised capability detection (Playbook 23).
 *
 * Every "does this browser support X" question is answered here and nowhere
 * else. Scattered feature sniffing is how a product ends up crashing on one
 * Safari version and nobody knows which check was missing.
 *
 * Detection is non-invasive: nothing here prompts for a permission, opens a
 * microphone or downloads a model. It only reports what the environment claims
 * to offer, so it is safe to run on first paint.
 */

export interface Capabilities {
  /** `getUserMedia` exists. Says nothing about permission or hardware. */
  microphone: boolean;
  webAudio: boolean;
  /** `MediaRecorder` plus at least one MIME type it will actually record. */
  mediaRecorder: boolean;
  recordingMimeType: string | null;
  offlineAudio: boolean;
  webWorker: boolean;
  indexedDb: boolean;
  webAssembly: boolean;
  webgl2: boolean;
  /** Cache Storage, used to keep the transcription model between visits. */
  cacheStorage: boolean;
  /** Device memory in GB where the browser reports it. */
  deviceMemoryGb: number | null;
  hardwareConcurrency: number;
  prefersReducedMotion: boolean;
  /** Coarse pointer, i.e. touch. Changes hit-target sizing decisions. */
  coarsePointer: boolean;
}

/**
 * Candidate recording formats, best first.
 *
 * Opus is preferred: it is the only one of these that stays faithful at low
 * bitrates on a hummed vowel. Safari records MP4/AAC and nothing else, so that
 * fallback is not optional.
 */
export const RECORDING_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const;

export function detectCapabilities(): Capabilities {
  if (typeof window === 'undefined') return serverCapabilities();

  const nav = navigator as Navigator & { deviceMemory?: number };
  const webAudio =
    typeof window.AudioContext !== 'undefined' ||
    typeof (window as { webkitAudioContext?: unknown }).webkitAudioContext !== 'undefined';

  return {
    microphone: typeof nav.mediaDevices?.getUserMedia === 'function',
    webAudio,
    mediaRecorder: typeof window.MediaRecorder !== 'undefined',
    recordingMimeType: pickRecordingMimeType(),
    offlineAudio: typeof window.OfflineAudioContext !== 'undefined',
    webWorker: typeof window.Worker !== 'undefined',
    indexedDb: typeof window.indexedDB !== 'undefined',
    webAssembly: typeof WebAssembly !== 'undefined',
    webgl2: detectWebgl2(),
    cacheStorage: typeof window.caches !== 'undefined',
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: nav.hardwareConcurrency ?? 2,
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
  };
}

function serverCapabilities(): Capabilities {
  return {
    microphone: false,
    webAudio: false,
    mediaRecorder: false,
    recordingMimeType: null,
    offlineAudio: false,
    webWorker: false,
    indexedDb: false,
    webAssembly: typeof WebAssembly !== 'undefined',
    webgl2: false,
    cacheStorage: false,
    deviceMemoryGb: null,
    hardwareConcurrency: 1,
    prefersReducedMotion: false,
    coarsePointer: false,
  };
}

export function pickRecordingMimeType(): string | null {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return null;
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  // Some builds report nothing as supported but still record at the default.
  return '';
}

function detectWebgl2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/**
 * Whether the core creation flow can run at all.
 * Missing pieces are named so the UI can say which one, not just "unsupported".
 */
export function assessCoreSupport(capabilities: Capabilities): {
  supported: boolean;
  missing: Array<keyof Capabilities>;
} {
  const required: Array<keyof Capabilities> = [
    'microphone',
    'webAudio',
    'mediaRecorder',
    'offlineAudio',
  ];
  const missing = required.filter((key) => capabilities[key] === false);
  return { supported: missing.length === 0, missing };
}

export type PerformanceTier = 'full' | 'reduced' | 'minimal';

/**
 * D-0705 - the three-level degradation ladder.
 *
 * Deliberately conservative: a phone that reports 4 GB and four cores gets the
 * reduced tier, not the full one, because the number a browser reports is a
 * ceiling rather than what is free while a 20 MB model is resident. The user
 * can always raise it by hand; a stuttering record screen is unrecoverable.
 */
export function assessPerformanceTier(capabilities: Capabilities): PerformanceTier {
  if (capabilities.prefersReducedMotion) return 'minimal';
  if (!capabilities.webgl2) return 'minimal';
  const memory = capabilities.deviceMemoryGb;
  const cores = capabilities.hardwareConcurrency;
  if (memory !== null && memory <= 4) return 'reduced';
  if (cores <= 4) return 'reduced';
  if (capabilities.coarsePointer && (memory === null || memory < 8)) return 'reduced';
  return 'full';
}
