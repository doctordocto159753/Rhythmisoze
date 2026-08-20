import 'server-only';

/**
 * US-1008 - basic abuse controls.
 *
 * A fixed-window counter held in module memory. Its limitations are real and
 * worth stating rather than discovering later: it is per serverless instance,
 * so the effective limit across a scaled deployment is higher than the number
 * below, and it resets on cold start.
 *
 * That is still worth having. It stops the case this actually needs to stop -
 * one client looping the publish endpoint - at zero infrastructure cost. A
 * deployment that needs a real global limit should put one in front of the
 * route (Vercel Firewall, or a Redis counter); the runbook says so, and the
 * interface here does not change when that happens.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Bounded so a flood of distinct keys cannot grow the map without limit. */
const MAX_TRACKED_KEYS = 5000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, for the `Retry-After` header. */
  retryAfterSec: number;
}

export function rateLimit(key: string, limit: number, windowSec: number): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (existing === undefined || existing.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_KEYS) evictExpired(now);
    windows.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { allowed: true, remaining: limit - 1, retryAfterSec: windowSec };
  }

  existing.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSec,
  };
}

function evictExpired(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  // Still full of live windows: drop the oldest rather than refusing everyone.
  if (windows.size >= MAX_TRACKED_KEYS) {
    const oldest = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of oldest.slice(0, Math.floor(MAX_TRACKED_KEYS / 4))) windows.delete(key);
  }
}

/**
 * A rate-limit key for a request.
 *
 * Uses the forwarded client address, hashed with a per-process salt so the map
 * never holds a raw IP address. Falls back to a constant key when no address is
 * available, which makes the limit global rather than absent - the safe
 * direction to fail in.
 */
export function requestKey(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const address = forwarded.split(',')[0]?.trim() ?? '';
  return `${scope}:${address === '' ? 'unknown' : hash(address)}`;
}

const SALT = Math.random().toString(36).slice(2);

function hash(value: string): string {
  let h = 0x811c9dc5;
  const input = `${SALT}${value}`;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
