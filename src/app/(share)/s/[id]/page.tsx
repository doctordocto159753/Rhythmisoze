import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getInstrument } from '@synthesis';
import { getMessages, negotiateLocale, SITE_URL_FALLBACK } from './shareUtils';
import { isPublishConfigured, SITE_URL } from '@/server/config';
import { findPublished, toPublicSketch } from '@/server/db';
import { SharePlayer } from './SharePlayer';
import styles from './share.module.css';

/**
 * US-1005 / D-0604 - the public share page.
 *
 * Server-rendered on purpose. The recipient is someone who followed a link from
 * a chat app, has never heard of the product, and will leave if the first thing
 * they see is a loading state. Everything above the fold - the title, the
 * instrument, the player - comes down in the HTML; the only client code is the
 * playback control itself.
 */

export const revalidate = 300;

interface Props {
  params: Promise<{ id: string }>;
}

async function load(id: string) {
  if (!isPublishConfigured()) return null;
  const row = await findPublished(id);
  return row === null ? null : toPublicSketch(row);
}

/**
 * US-1006 - social metadata.
 *
 * The title pattern is the one the PRD specifies, localized, and the image is
 * generated per sketch by `/api/og`. Both are absolute URLs: a relative OG
 * image is silently dropped by most platforms.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const sketch = await load(id);
  const locale = negotiateLocale((await headers()).get('accept-language'));
  const t = getMessages(locale);
  const base = SITE_URL || SITE_URL_FALLBACK;

  if (sketch === null) {
    return { title: t.share.notFound, robots: { index: false, follow: false } };
  }

  const title = t.share.madeWith(sketch.title || t.workspace.untitled);
  const instrument = getInstrument(sketch.instrumentId);
  const description = t.share.details(instrument?.name[locale] ?? sketch.instrumentId, sketch.bpm);
  const image = `${base}/api/og?id=${encodeURIComponent(sketch.id)}`;

  return {
    title,
    description,
    metadataBase: new URL(base),
    alternates: { canonical: `/s/${sketch.id}` },
    openGraph: {
      title,
      description,
      url: `${base}/s/${sketch.id}`,
      type: 'music.song',
      images: [{ url: image, width: 1200, height: 630, alt: title }],
      locale: locale === 'fa' ? 'fa_IR' : 'en_US',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
    // Published sketches are user content on a shared link, not pages the
    // product wants ranked. Indexing them would also make the "unguessable
    // link" property meaningless.
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({ params }: Props) {
  const { id } = await params;
  const sketch = await load(id);
  const locale = negotiateLocale((await headers()).get('accept-language'));
  const t = getMessages(locale);

  if (sketch === null) notFound();

  const instrument = getInstrument(sketch.instrumentId);
  const instrumentName = instrument?.name[locale] ?? sketch.instrumentId;

  return (
    <main className={styles.page}>
      <article className={styles.card}>
        <header className={styles.header}>
          <svg className={styles.mark} viewBox="0 0 24 24" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M4 16.5v3" />
              <path d="M9.3 11v8.5" />
              <path d="M14.7 6.5v13" />
              <path d="M20 3.5v16" />
            </g>
          </svg>
          <span className={styles.brand}>{t.app.name}</span>
        </header>

        <h1 className={styles.title}>{sketch.title || t.workspace.untitled}</h1>
        <p className={styles.meta}>
          <bdi dir="auto">{instrumentName}</bdi>
          {' · '}
          <bdi dir="ltr">{sketch.bpm} BPM</bdi>
          {sketch.keyRoot !== null ? (
            <>
              {' · '}
              <bdi dir="ltr">
                {sketch.keyRoot} {sketch.keyMode}
              </bdi>
            </>
          ) : null}
        </p>

        <SharePlayer
          id={sketch.id}
          audioUrl={sketch.audioUrl}
          durationSec={sketch.durationSec}
          playLabel={t.share.play}
          pauseLabel={t.share.pause}
        />

        <a className={styles.download} href={sketch.audioUrl} download>
          {t.share.downloadAudio}
        </a>
      </article>

      {/* E-06 - the CTA is present and clearly secondary to listening. */}
      <aside className={styles.cta}>
        <h2 className={styles.ctaTitle}>{t.share.tryIt}</h2>
        <p className={styles.ctaBody}>{t.share.tryItBody}</p>
        <a className={styles.ctaLink} href={`/${locale}`} data-cta="try-it">
          {t.landing.start}
        </a>
      </aside>
    </main>
  );
}
