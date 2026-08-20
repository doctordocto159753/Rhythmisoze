/**
 * Root layout for the creation experience.
 *
 * There are two root layouts in this app - this one and the share page's -
 * because they are genuinely different documents. The creation app is a
 * localized, interactive, client-heavy instrument; a share page is a small
 * public document that must render on the server, load fast for someone who has
 * never heard of Rhythmisoze, and carry its own social metadata.
 *
 * `lang` and `dir` are set here from the route segment, which is the only place
 * they can be set correctly at first paint (US-0102).
 */

import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { Locale } from '@contracts';
import { directionOf, getMessages, isLocale, LOCALES } from '@/i18n';
import { LocaleProvider } from '@/i18n/provider';
import { AppFrame } from '@/features/shell/AppFrame';
import '@/styles/globals.css';

export function generateStaticParams(): Array<{ locale: Locale }> {
  return LOCALES.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  // The record screen is a single stage; letting it zoom is fine, letting it
  // rubber-band while the user holds a record button is not.
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf7f2' },
    { media: '(prefers-color-scheme: dark)', color: '#17150f' },
  ],
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getMessages(locale);

  return {
    title: { default: `${t.app.name} — ${t.app.tagline}`, template: `%s — ${t.app.name}` },
    description: t.app.description,
    applicationName: t.app.name,
    // Both locales are always reachable; declaring them stops a search engine
    // from treating the Persian page as a duplicate of the English one.
    alternates: {
      canonical: `/${locale}`,
      languages: { fa: '/fa', en: '/en' },
    },
    openGraph: {
      title: `${t.app.name} — ${t.app.tagline}`,
      description: t.app.description,
      locale: locale === 'fa' ? 'fa_IR' : 'en_US',
      type: 'website',
    },
    robots: { index: true, follow: true },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={locale} dir={directionOf(locale)} suppressHydrationWarning>
      <body>
        <LocaleProvider locale={locale}>
          <AppFrame>{children}</AppFrame>
        </LocaleProvider>
      </body>
    </html>
  );
}
