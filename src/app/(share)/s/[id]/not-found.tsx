import { headers } from 'next/headers';
import { getMessages, negotiateLocale } from './shareUtils';
import styles from './share.module.css';

/**
 * US-1005 - a deleted or unknown sketch.
 *
 * Says what happened in one sentence and offers the same CTA the real page
 * does. A visitor who followed a dead link is still a visitor.
 */
export default async function ShareNotFound() {
  const locale = negotiateLocale((await headers()).get('accept-language'));
  const t = getMessages(locale);

  return (
    <main className={styles.page}>
      <article className={styles.card}>
        <h1 className={styles.title}>{t.share.notFound}</h1>
        <p className={styles.meta}>{t.share.notFoundBody}</p>
      </article>
      <aside className={styles.cta}>
        <h2 className={styles.ctaTitle}>{t.share.tryIt}</h2>
        <p className={styles.ctaBody}>{t.share.tryItBody}</p>
        <a className={styles.ctaLink} href={`/${locale}`}>
          {t.landing.start}
        </a>
      </aside>
    </main>
  );
}
