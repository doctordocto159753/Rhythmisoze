/**
 * US-0102 / US-0103 - the bilingual contract.
 *
 * Gate G5 says Persian must not be "a translated afterthought". Two of the ways
 * that goes wrong are checkable here rather than by eye: a key that exists in
 * one catalog and not the other, and a formatter that quietly changes what a
 * number means depending on the locale.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  directionOf,
  formatBpm,
  formatDate,
  formatDuration,
  formatNoteName,
  getMessages,
  isLocale,
  localePath,
  localizeDigits,
  negotiateLocale,
  neutralizeBidi,
  otherLocale,
} from '@/i18n';
import { en } from '@/i18n/messages/en';
import { fa } from '@/i18n/messages/fa';

type Shape = { [key: string]: 'string' | 'function' | Shape };

/** Records the *shape* of a catalog: key names and value kinds, not values. */
function shapeOf(value: unknown, path = ''): Shape {
  const shape: Shape = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (typeof entry === 'string') shape[key] = 'string';
    else if (typeof entry === 'function') shape[key] = 'function';
    else if (entry !== null && typeof entry === 'object') shape[key] = shapeOf(entry, here);
    else throw new Error(`unexpected catalog value at ${here}: ${typeof entry}`);
  }
  return shape;
}

function flatten(shape: Shape, path = ''): string[] {
  return Object.entries(shape).flatMap(([key, value]) => {
    const here = path === '' ? key : `${path}.${key}`;
    return typeof value === 'string' ? [`${here}:${value}`] : flatten(value, here);
  });
}

describe('catalogs', () => {
  it('have identical shapes', () => {
    // A missing key is already a type error; this catches the other direction -
    // a key added to Persian and never added to English.
    expect(flatten(shapeOf(fa)).sort()).toEqual(flatten(shapeOf(en)).sort());
  });

  it('cover every error code with a message', () => {
    for (const catalog of [en, fa]) {
      for (const code of Object.keys(en.errors)) {
        if (code === 'title' || code === 'recovery' || code === 'hints') continue;
        expect(typeof (catalog.errors as Record<string, unknown>)[code]).toBe('string');
      }
    }
  });

  it('cover every recovery action', () => {
    const actions = ['retry', 'rerecord', 'reload', 'choose_other_instrument', 'free_space', 'check_permissions', 'none'];
    for (const catalog of [en, fa]) {
      for (const action of actions) {
        expect(typeof (catalog.errors.recovery as Record<string, unknown>)[action]).toBe('string');
      }
    }
  });

  it('have no empty strings', () => {
    const empties: string[] = [];
    const walk = (value: unknown, path: string): void => {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const here = `${path}.${key}`;
        if (typeof entry === 'string' && entry.trim() === '') empties.push(here);
        else if (entry !== null && typeof entry === 'object') walk(entry, here);
      }
    };
    walk(en, 'en');
    walk(fa, 'fa');
    expect(empties).toEqual([]);
  });

  it('do not leave English strings in the Persian catalog', () => {
    // Technical tokens that stay Latin on purpose: they are identifiers the
    // user compares against other tools (bilingual skill).
    const allowed = new Set([
      'English',
      'BPM',
      'MIDI',
      'WAV',
      'Web Audio',
      'WebAssembly',
      'Rhythmisoze',
    ]);
    const suspicious: string[] = [];
    const walk = (value: unknown, path: string): void => {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const here = `${path}.${key}`;
        if (typeof entry === 'string') {
          const latinWords = entry.match(/[A-Za-z][A-Za-z ]{3,}/g) ?? [];
          for (const word of latinWords) {
            if (!allowed.has(word.trim())) suspicious.push(`${here}: ${word.trim()}`);
          }
        } else if (entry !== null && typeof entry === 'object') walk(entry, here);
      }
    };
    walk(fa, 'fa');
    expect(suspicious).toEqual([]);
  });
});

describe('direction', () => {
  it('gives Persian RTL and English LTR', () => {
    expect(directionOf('fa')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });

  it('has Persian as the default', () => {
    expect(DEFAULT_LOCALE).toBe('fa');
    expect(LOCALES).toContain('fa');
    expect(LOCALES).toContain('en');
  });

  it('pairs the locales', () => {
    expect(otherLocale('fa')).toBe('en');
    expect(otherLocale('en')).toBe('fa');
  });

  it('recognises only real locales', () => {
    expect(isLocale('fa')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('formatting', () => {
  it('keeps BPM in Latin digits in both locales', () => {
    // A BPM value is an identifier the user matches against a metronome app.
    expect(formatBpm(128, 'en')).toContain('128');
    expect(formatBpm(128, 'fa')).toContain('128');
  });

  it('keeps note names Latin in both locales', () => {
    expect(formatNoteName('C#4')).toBe('C#4');
  });

  it('localises prose digits only for Persian', () => {
    expect(localizeDigits('2026', 'en')).toBe('2026');
    expect(localizeDigits('2026', 'fa')).toBe('۲۰۲۶');
  });

  it('formats durations with a stable shape', () => {
    expect(formatDuration(3.14)).toBe('3.1');
    expect(formatDuration(42)).toBe('42');
    expect(formatDuration(95)).toBe('1:35');
    expect(formatDuration(-5)).toBe('0.0');
  });

  it('formats a date in each locale without throwing', () => {
    const at = Date.UTC(2026, 7, 19, 12, 0, 0);
    expect(formatDate(at, 'en').length).toBeGreaterThan(0);
    expect(formatDate(at, 'fa').length).toBeGreaterThan(0);
  });

  it('strips bidi controls that could reorder a URL', () => {
    expect(neutralizeBidi('song‮dim.mid')).toBe('songdim.mid');
    expect(neutralizeBidi('plain')).toBe('plain');
  });
});

describe('locale paths', () => {
  it('builds prefixed paths', () => {
    expect(localePath('fa')).toBe('/fa');
    expect(localePath('en', 'workspace')).toBe('/en/workspace');
    expect(localePath('en', '/workspace')).toBe('/en/workspace');
  });
});

describe('negotiateLocale', () => {
  it('prefers Persian for a Persian speaker', () => {
    expect(negotiateLocale('fa-IR,fa;q=0.9,en;q=0.8')).toBe('fa');
  });

  it('picks English for an English speaker', () => {
    expect(negotiateLocale('en-GB,en;q=0.9')).toBe('en');
  });

  it('honours quality ordering rather than header order', () => {
    expect(negotiateLocale('en;q=0.3,fa;q=0.9')).toBe('fa');
  });

  it('falls back to the default for anything else', () => {
    expect(negotiateLocale('de-DE,de')).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale('')).toBe(DEFAULT_LOCALE);
  });
});

describe('messages', () => {
  it('returns the right catalog', () => {
    expect(getMessages('fa').app.name).toBe('ریتمیسوز');
    expect(getMessages('en').app.name).toBe('Rhythmisoze');
  });

  it('renders parameterised strings in both locales', () => {
    for (const locale of LOCALES) {
      const t = getMessages(locale);
      expect(t.review.notesHeard(12)).toContain('12');
      expect(t.share.madeWith('Test')).toContain('Test');
      expect(t.units.bpm(90)).toContain('90');
      expect(t.a11y.beat(2, 4)).toContain('2');
    }
  });
});
