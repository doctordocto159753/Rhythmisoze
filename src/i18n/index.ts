/**
 * US-0102 / US-0103 - locale resolution and direction-safe formatting.
 *
 * Small on purpose. The only hard parts of bilingual UI here are (a) making a
 * missing key impossible, which the type system handles, and (b) formatting
 * numbers and mixed-direction strings so they do not visually break in RTL,
 * which is what the rest of this file is for.
 */

import type { Locale } from '@contracts';
import { en, type Messages } from './messages/en';
import { fa } from './messages/fa';

export type { Messages };
export type { Locale };

export const LOCALES: readonly Locale[] = ['fa', 'en'];
export const DEFAULT_LOCALE: Locale = 'fa';

const CATALOGS: Record<Locale, Messages> = { en, fa };

export function isLocale(value: string | undefined): value is Locale {
  return value === 'fa' || value === 'en';
}

export function getMessages(locale: Locale): Messages {
  return CATALOGS[locale];
}

export function directionOf(locale: Locale): 'rtl' | 'ltr' {
  return CATALOGS[locale].meta.dir;
}

export function otherLocale(locale: Locale): Locale {
  return locale === 'fa' ? 'en' : 'fa';
}

/**
 * Digits.
 *
 * Persian UI uses Persian-Indic digits for prose numbers, because Latin digits
 * inside Persian text read as a foreign insert. BPM, note names and file names
 * deliberately keep Latin digits: they are identifiers a user compares against
 * a DAW, a metronome app or a filename, and localising them makes them harder
 * to match, not easier.
 */
const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

export function localizeDigits(value: string | number, locale: Locale): string {
  const text = String(value);
  if (locale !== 'fa') return text;
  return text.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] as string);
}

/** Formats a count for prose. */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US').format(value);
}

/**
 * Formats seconds as `m:ss` when it matters and `s.s` when it does not.
 * Always Latin digits inside the timer itself, because a running timer is read
 * as a measurement and the shape has to stay stable as it counts.
 */
export function formatDuration(seconds: number, options?: { precise?: boolean }): string {
  const safe = Math.max(0, seconds);
  if (options?.precise === true || safe < 60) {
    return safe < 10 ? safe.toFixed(1) : Math.round(safe).toString();
  }
  const minutes = Math.floor(safe / 60);
  const remainder = Math.round(safe % 60);
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

/** A date a person can read, in their own calendar. */
export function formatDate(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

/**
 * Wraps a Latin fragment for embedding in Persian text.
 *
 * Returns the raw string; the caller renders it inside `<bdi>`. That is the
 * correct mechanism - `text-align` and manual reordering are not (bilingual
 * skill: "using text-align:right as the whole RTL strategy" is listed as an
 * anti-pattern).
 */
export function neutralizeBidi(value: string): string {
  // Strip any embedded directional override the value might carry, so a note
  // title cannot reorder the surrounding sentence.
  return value.replace(/[‎‏‪-‮⁦-⁩]/g, '');
}

/**
 * Note names stay Latin in both locales.
 *
 * "C#4" is the name of a thing, like a model number. A Persian musician reading
 * this app is going to compare it against a keyboard, a tuner or a DAW, all of
 * which say "C#4".
 */
export function formatNoteName(name: string): string {
  return name;
}

/** BPM, always Latin digits, always followed by the unit in both locales. */
export function formatBpm(bpm: number, locale: Locale): string {
  return getMessages(locale).units.bpm(Math.round(bpm));
}

/** Builds a locale-prefixed path. */
export function localePath(locale: Locale, path = ''): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return clean.length > 0 ? `/${locale}/${clean}` : `/${locale}`;
}

/**
 * Picks a locale from an `Accept-Language` header.
 * Falls back to Persian, which is the product's primary audience.
 */
export function negotiateLocale(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const entries = header
    .split(',')
    .map((part) => {
      const [tag = '', quality = 'q=1'] = part.trim().split(';');
      return { tag: tag.trim().toLowerCase(), q: Number(quality.replace('q=', '')) || 0 };
    })
    .sort((a, b) => b.q - a.q);

  for (const entry of entries) {
    if (entry.tag.startsWith('fa') || entry.tag.startsWith('pe')) return 'fa';
    if (entry.tag.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}
