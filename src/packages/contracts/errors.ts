/**
 * Typed error categories. Every failure the user can hit maps to one of these
 * codes, and every code maps to a localized message plus a next action.
 * Playbook §23: never swallow errors, never surface a raw stack to a user.
 */

export const APP_ERROR_CODES = [
  'mic_permission_denied',
  'mic_unavailable',
  'mic_in_use',
  'recording_failed',
  'decode_failed',
  'audio_silent',
  'audio_clipped',
  'audio_too_short',
  'model_load_failed',
  'transcription_failed',
  'transcription_empty',
  'transcription_cancelled',
  'worker_unavailable',
  'retouch_failed',
  'instrument_load_failed',
  'render_failed',
  'export_failed',
  'storage_quota_exceeded',
  'storage_unavailable',
  'storage_failed',
  'publish_disabled',
  'publish_upload_failed',
  'publish_rejected',
  'publish_rate_limited',
  'network_unavailable',
  'unsupported_browser',
  'unknown',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** What the user can do about it. Drives which button the error state offers. */
export type RecoveryAction =
  | 'retry'
  | 'rerecord'
  | 'reload'
  | 'choose_other_instrument'
  | 'free_space'
  | 'check_permissions'
  | 'none';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly recovery: RecoveryAction;
  /** Safe to send to telemetry: never contains audio or note content. */
  readonly detail: string | undefined;

  constructor(
    code: AppErrorCode,
    recovery: RecoveryAction = 'retry',
    detail?: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`, options);
    this.name = 'AppError';
    this.code = code;
    this.recovery = recovery;
    this.detail = detail;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Wraps anything thrown into an AppError without losing the original cause. */
export function toAppError(
  value: unknown,
  fallback: AppErrorCode = 'unknown',
  recovery: RecoveryAction = 'retry',
): AppError {
  if (isAppError(value)) return value;
  const detail = value instanceof Error ? value.name : typeof value;
  return new AppError(fallback, recovery, detail, { cause: value });
}
