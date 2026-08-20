import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n';
import { DesignCatalog } from '@/features/design/DesignCatalog';

export const metadata: Metadata = {
  title: 'Design catalog',
  // A development reference, not a page anybody should find in a search result.
  robots: { index: false, follow: false },
};

/**
 * D-0801 / D-0802 - the component and state catalog.
 *
 * Reachable at `/fa/design` and `/en/design`. Every state has a stable anchor,
 * so a screenshot suite can target them directly.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <DesignCatalog />;
}
