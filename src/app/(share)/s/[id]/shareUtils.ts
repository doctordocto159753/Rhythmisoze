/**
 * Re-exports for the share route.
 *
 * The share page is server-rendered and locale-negotiated rather than
 * locale-routed, so it needs the i18n helpers without the client provider.
 * Keeping the import surface here makes it obvious that this route deliberately
 * does not use the `[locale]` segment.
 */

export { getMessages, negotiateLocale } from '@/i18n';

/** Used when NEXT_PUBLIC_SITE_URL is unset, so OG metadata still resolves. */
export const SITE_URL_FALLBACK = 'http://localhost:3000';
