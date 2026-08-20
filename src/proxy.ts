/**
 * US-0102 - locale routing.
 *
 * Next.js 16 renamed the `middleware` convention to `proxy`; this is that file.
 *
 * Two jobs: send a bare `/` to a locale the visitor can read, and remember the
 * choice once they make one. Everything else is a plain nested route.
 *
 * Persian is the default when nothing is known, because that is the product's
 * primary audience - not because it is first alphabetically.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, isLocale, negotiateLocale } from '@/i18n';

const LOCALE_COOKIE = 'rhythmisoze-locale';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const firstSegment = pathname.split('/')[1];
  if (isLocale(firstSegment)) {
    // Remember an explicit visit so the next bare `/` lands in the same place.
    const response = NextResponse.next();
    if (request.cookies.get(LOCALE_COOKIE)?.value !== firstSegment) {
      response.cookies.set(LOCALE_COOKIE, firstSegment, {
        maxAge: COOKIE_MAX_AGE,
        sameSite: 'lax',
        path: '/',
      });
    }
    return response;
  }

  const remembered = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(remembered)
    ? remembered
    : negotiateLocale(request.headers.get('accept-language')) || DEFAULT_LOCALE;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Share pages, API routes, static assets and the worker bundle are all
  // locale-neutral and must not be redirected.
  matcher: ['/((?!api|s/|_next|models|instruments|favicon|icon|apple-icon|opengraph|robots|sitemap).*)'],
};
