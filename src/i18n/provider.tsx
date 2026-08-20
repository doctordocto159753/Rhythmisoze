'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Locale } from '@contracts';
import { directionOf, getMessages, localePath, otherLocale, type Messages } from './index';

interface LocaleValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: Messages;
  other: Locale;
  /** Path to the same page in the other locale. */
  switchPath(currentPath: string): string;
}

const LocaleContext = createContext<LocaleValue | null>(null);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<LocaleValue>(
    () => ({
      locale,
      dir: directionOf(locale),
      t: getMessages(locale),
      other: otherLocale(locale),
      switchPath(currentPath: string) {
        // Swap only the first segment; everything after it is preserved so the
        // user stays on the page they were reading (US-0102: "changing language
        // preserves the current flow state where technically safe").
        const rest = currentPath.replace(/^\/(fa|en)(?=\/|$)/, '');
        return localePath(otherLocale(locale), rest);
      },
    }),
    [locale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext);
  if (value === null) {
    // Failing loudly beats rendering English into a Persian page.
    throw new Error('useLocale must be used inside <LocaleProvider>');
  }
  return value;
}

/** Shorthand for the common case of only needing the catalog. */
export function useMessages(): Messages {
  return useLocale().t;
}
