import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMessages, isLocale } from '@/i18n';
import { WorkspacePage } from '@/features/workspace/WorkspacePage';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: getMessages(locale).workspace.title };
}

/**
 * The workspace route.
 *
 * Everything below is client-side: the sketches live in IndexedDB, which does
 * not exist on the server. Rendering an empty list on the server and then
 * replacing it would produce a visible flash of "nothing here yet" for a user
 * who has ten sketches.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <WorkspacePage />;
}
