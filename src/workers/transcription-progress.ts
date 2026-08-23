export interface ProgressWindow {
  start: number;
  span: number;
}

/** Maps a sub-engine's 0..1 progress into a request window without regression. */
export function mapMonotonicProgress(
  previous: number,
  progress: number,
  window: ProgressWindow,
): number {
  const bounded = Math.max(0, Math.min(1, progress));
  const mapped = window.start + bounded * window.span;
  return Math.max(previous, Math.min(1, mapped));
}
