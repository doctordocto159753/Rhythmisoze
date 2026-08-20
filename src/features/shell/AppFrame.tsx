'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { localePath } from '@/i18n';
import { useLocale } from '@/i18n/provider';
import styles from './AppFrame.module.css';

/**
 * The mark. Three strokes rising - a gesture turning into pitch.
 * Inline rather than an asset so it inherits `currentColor` and costs no request.
 */
function Mark() {
  return (
    <svg className={styles.mark} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M4 16.5v3" />
        <path d="M9.3 11v8.5" />
        <path d="M14.7 6.5v13" />
        <path d="M20 3.5v16" />
      </g>
    </svg>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const { locale, t, switchPath } = useLocale();
  const pathname = usePathname();

  const createHref = localePath(locale);
  const workspaceHref = localePath(locale, 'workspace');
  const isWorkspace = pathname.startsWith(workspaceHref);

  return (
    <div className={styles.frame}>
      <a className="skip-link" href="#main">
        {t.nav.skipToContent}
      </a>

      <header className={styles.masthead}>
        <Link className={styles.brand} href={createHref}>
          <Mark />
          <span>{t.app.name}</span>
        </Link>

        <nav className={styles.nav} aria-label={t.nav.create}>
          <Link
            className={[styles.navLink, !isWorkspace ? styles.navLinkActive : null]
              .filter(Boolean)
              .join(' ')}
            href={createHref}
            aria-current={!isWorkspace ? 'page' : undefined}
          >
            {t.nav.create}
          </Link>
          <Link
            className={[styles.navLink, isWorkspace ? styles.navLinkActive : null]
              .filter(Boolean)
              .join(' ')}
            href={workspaceHref}
            aria-current={isWorkspace ? 'page' : undefined}
          >
            {t.nav.workspace}
          </Link>
          {/* `lang` and `hrefLang` on the switch so a screen reader pronounces
              the target language's own name correctly. */}
          <Link
            className={styles.navLink}
            href={switchPath(pathname)}
            lang={locale === 'fa' ? 'en' : 'fa'}
            hrefLang={locale === 'fa' ? 'en' : 'fa'}
            aria-label={t.nav.switchLanguage}
          >
            {t.meta.otherLocaleName}
          </Link>
        </nav>
      </header>

      <main className={styles.main} id="main">
        {children}
      </main>

      <footer className={styles.footer}>
        {/* US-1104: the local-processing claim is stated where it is always
            true, and the publish flow states its own, different promise. */}
        <span className={styles.privacyNote}>
          <span className={styles.dot} aria-hidden="true" />
          {t.privacy.localTitle}
        </span>
        <span>{t.app.tagline}</span>
      </footer>
    </div>
  );
}
