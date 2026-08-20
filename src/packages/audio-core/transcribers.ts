/**
 * US-0304 / US-0502 - transcribers behind the normalized contract.
 *
 * Both classes here implement `AudioTranscriber`, so the UI, the retouch
 * pipeline and the worker protocol never learn which one ran. That is the whole
 * point of Playbook 6.4: swapping Basic Pitch for a pitch tracker, or for a
 * server backend, must be a one-line change at the composition root and nothing
 * else.
 *
 * The Basic Pitch implementation lives in `features/transcription` because it
 * needs the worker and the network. These two are pure DSP and run anywhere,
 * including in CI.
 */

import type {
  AudioTranscriber,
  MonoAudio,
  ProcessingDiagnostics,
  TranscriptionOptions,
  TranscriptionProgress,
  TranscriptionResult,
} from '@contracts';
import { AppError } from '@contracts';
import { classifyOnsets } from './drums';
import { peakNormalize } from './normalize';
import { detectOnsets, DEFAULT_ONSET_OPTIONS } from './onsets';
import { DEFAULT_SEGMENT_OPTIONS, DEFAULT_YIN_OPTIONS, segmentNotes, trackPitch } from './pitch';

/** Wall clock that also works in a worker and in Node. */
const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Monophonic transcription by YIN pitch tracking.
 *
 * The fallback path for melody, and the reference implementation the tests run
 * against. It is honest about what it is: monophonic only, and the UI labels
 * results produced by it so a user comparing two sessions is not confused by a
 * quality difference they cannot see the cause of.
 */
export class PitchTrackerTranscriber implements AudioTranscriber {
  readonly id = 'pitch-tracker' as const;
  readonly backend = 'browser' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async transcribe(
    input: MonoAudio,
    options: TranscriptionOptions,
    onProgress?: (p: TranscriptionProgress) => void,
  ): Promise<TranscriptionResult> {
    const started = now();
    onProgress?.({ stage: 'preparing_audio', progress: 0.05 });
    throwIfAborted(options.signal);

    const normalized = peakNormalize(input);
    onProgress?.({ stage: 'inferring', progress: 0.2 });

    const frames = trackPitch(normalized.samples, normalized.sampleRate, DEFAULT_YIN_OPTIONS);
    throwIfAborted(options.signal);
    onProgress?.({ stage: 'collecting', progress: 0.8 });

    const segmentOptions = {
      ...DEFAULT_SEGMENT_OPTIONS,
      minDurationSec: options.minNoteLengthSec ?? DEFAULT_SEGMENT_OPTIONS.minDurationSec,
      minClarity: options.noteThreshold ?? DEFAULT_SEGMENT_OPTIONS.minClarity,
    };
    const notes = segmentNotes(
      frames,
      segmentOptions,
      DEFAULT_YIN_OPTIONS.hopSize / normalized.sampleRate,
    );

    onProgress?.({ stage: 'done', progress: 1 });

    const diagnostics: ProcessingDiagnostics = {
      transcriberId: this.id,
      backend: this.backend,
      elapsedMs: now() - started,
      modelLoadMs: 0,
      modelFromCache: true,
      notesBeforeFilter: notes.length,
      notesAfterFilter: notes.length,
      warnings: [],
    };

    return { notes, durationSec: input.durationSec, diagnostics };
  }
}

/**
 * The rhythm path (WP-05): onsets, then classification, then GM drum events.
 *
 * Not a variant of melody transcription. It never estimates a pitch, and it
 * reports its raw onsets alongside the classified drums so the review screen can
 * show what was heard even when a class was ambiguous.
 */
export class RhythmTranscriber implements AudioTranscriber {
  readonly id = 'pitch-tracker' as const;
  readonly backend = 'browser' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async transcribe(
    input: MonoAudio,
    options: TranscriptionOptions,
    onProgress?: (p: TranscriptionProgress) => void,
  ): Promise<TranscriptionResult> {
    const started = now();
    onProgress?.({ stage: 'preparing_audio', progress: 0.05 });
    throwIfAborted(options.signal);

    const normalized = peakNormalize(input);
    onProgress?.({ stage: 'inferring', progress: 0.3 });

    const detection = detectOnsets(normalized.samples, normalized.sampleRate, {
      ...DEFAULT_ONSET_OPTIONS,
      thresholdRatio: options.onsetThreshold
        ? 1 + options.onsetThreshold * 1.4
        : DEFAULT_ONSET_OPTIONS.thresholdRatio,
    });
    throwIfAborted(options.signal);
    onProgress?.({ stage: 'collecting', progress: 0.85 });

    const drums = classifyOnsets(detection.onsets);
    const ambiguous = drums.filter((d) => d.drum === 'unknown').length;
    onProgress?.({ stage: 'done', progress: 1 });

    const diagnostics: ProcessingDiagnostics = {
      transcriberId: this.id,
      backend: this.backend,
      elapsedMs: now() - started,
      modelLoadMs: 0,
      modelFromCache: true,
      notesBeforeFilter: detection.onsets.length,
      notesAfterFilter: drums.length,
      warnings: ambiguous > 0 ? [`ambiguous_onsets:${ambiguous}`] : [],
    };

    return {
      notes: [],
      onsets: detection.onsets,
      drums,
      durationSec: input.durationSec,
      diagnostics,
    };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AppError('transcription_cancelled', 'none', 'aborted');
}
