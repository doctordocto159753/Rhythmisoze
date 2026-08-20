import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMessages, isLocale } from '@/i18n';
import { CreationPage } from '@/features/creation/CreationPage';
import { isPublishConfigured } from '@/server/config';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getMessages(locale);
  return { title: t.app.tagline, description: t.app.description };
}

/**
 * The creation route.
 *
 * A thin server component: it resolves the locale, asks the server once whether
 * publishing is configured, and hands both to the client. Everything below is
 * client-side because it touches the microphone, Web Audio, IndexedDB and WebGL
 * (Playbook 10.2).
 *
 * `publishEnabled` is computed here rather than in the browser so a deployment
 * without storage credentials hides the publish action entirely, instead of
 * offering it and failing at upload time.
 */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <CreationPage publishEnabled={isPublishConfigured()} />;
}
