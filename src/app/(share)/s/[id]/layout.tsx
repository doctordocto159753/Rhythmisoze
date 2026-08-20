/**
 * Root layout for public share pages.
 *
 * A second root layout, deliberately. A share page is a different document from
 * the creation app: it is server-rendered, has no microphone, no worker and no
 * IndexedDB, and its whole job is to let someone who has never heard of
 * Rhythmisoze press play within a second of opening a link.
 *
 * The locale is negotiated from the visitor's `Accept-Language` rather than
 * taken from a path segment, because the URL shape the PRD specifies is
 * `/s/{id}` with no locale in it, and the person opening it is usually not the
 * person who made it.
 */

import type { Viewport } from 'next';
import { headers } from 'next/headers';
import { directionOf, negotiateLocale } from '@/i18n';
import { LocaleProvider } from '@/i18n/provider';
import '@/styles/globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf7f2' },
    { media: '(prefers-color-scheme: dark)', color: '#17150f' },
  ],
};

export default async function ShareLayout({ children }: { children: React.ReactNode }) {
  const locale = negotiateLocale((await headers()).get('accept-language'));

  return (
    <html lang={locale} dir={directionOf(locale)} suppressHydrationWarning>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
