'use client';

/**
 * The Musician area on the review screen.
 *
 * ## What it is not
 *
 * It is not a modal, it does not cover the transport, and it never disables the
 * rest of the screen. While a generation runs the user can still play any
 * version, change instrument, move the cleanup slider and leave the page — that
 * is the whole point of the feature being asynchronous, and a busy overlay
 * would quietly undo it (AC-04).
 *
 * ## Status is announced, not just drawn
 *
 * Generation finishes at an unpredictable moment, potentially while the user is
 * looking somewhere else. A spinner that changes colour tells a sighted user
 * something and a screen-reader user nothing, so the status line is a live
 * region. It is `polite` rather than `assertive`: this is news, not an
 * emergency, and interrupting someone mid-sentence to say a version is ready
 * would be worse than telling them a moment later.
 */

import type { AppError } from '@contracts';
import { Button } from '@/components/Button';
import { Row, Stack, Well } from '@/components/Layout';
import { Text } from '@/components/Text';
import { useMessages } from '@/i18n/provider';
import type { MusicianPhase } from './useMusicianJob';
import styles from './MusicianPanel.module.css';

export interface MusicianPanelProps {
  phase: MusicianPhase;
  busy: boolean;
  hasResult: boolean;
  hasPending: boolean;
  error: AppError | null;
  /** Configured and reachable. False hides the whole area rather than teasing. */
  available: boolean;
  /**
   * Versions that exist but are not being offered, and why.
   *
   * `refused` -- the service returned the Teacher's own notes because nothing
   * survived the Identity Guard. `stale` -- the tidied version has moved since
   * these were generated, so they are a variation on a phrase that is no longer
   * on screen.
   *
   * Both are reported rather than silently omitted. A user who pressed a button,
   * waited, and sees no new version needs to be able to tell "the musician had
   * nothing to add" from "the app lost it".
   */
  withheld?: { stale: boolean; refused: boolean };
  onGenerate(): void;
  onRegenerate(): void;
  onCancel(): void;
  onKeepPending(): void;
  onDiscardPending(): void;
}

export function MusicianPanel({
  phase,
  busy,
  hasResult,
  hasPending,
  error,
  available,
  withheld,
  onGenerate,
  onRegenerate,
  onCancel,
  onKeepPending,
  onDiscardPending,
}: MusicianPanelProps) {
  const t = useMessages();

  // Not configured for this deployment. Showing a disabled button would
  // advertise something the user can never have; showing nothing is honest.
  if (!available) return null;

  const status = busy
    ? phase === 'queued'
      ? t.versions.musician.queued
      : phase === 'refining_local'
        ? t.versions.musician.refiningLocal
        : t.versions.musician.generatingGlobal
    : phase === 'cancelled'
      ? t.versions.musician.cancelled
      : hasResult && phase === 'completed'
        ? t.versions.musician.ready
        : null;

  return (
    <Well as="section" aria-labelledby="musician-heading">
      <Stack gap={3}>
        <Stack gap={1}>
          <Text variant="heading" as="h3" id="musician-heading">
            {t.versions.musician.title}
          </Text>
          <Text variant="micro" muted>
            {t.versions.musician.intro}
          </Text>
        </Stack>

        {/*
          One live region for the whole area, always present in the DOM.
          A region that is added and removed is announced inconsistently across
          screen readers; one that persists and changes its text is not.
        */}
        <div className={styles.status} role="status" aria-live="polite" aria-atomic="true">
          {status ? (
            <Row gap={2} align="center">
              {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
              <Text variant="micro">{status}</Text>
            </Row>
          ) : null}
        </div>

        {/*
          Not an error, and not styled as one: nothing failed. These are outcomes
          with a next step, so they read as explanations and sit above the
          buttons that act on them.
        */}
        {withheld?.refused ? (
          <Text variant="micro" muted>
            {t.versions.musician.refused}
          </Text>
        ) : null}
        {withheld?.stale ? (
          <Text variant="micro" muted>
            {t.versions.musician.stale}
          </Text>
        ) : null}

        {error ? (
          <Text variant="micro" className={styles.error}>
            {phase === 'failed' && error.code === 'musician_timeout'
              ? t.versions.musician.timedOut
              : error.code === 'musician_failed'
                ? t.versions.musician.failed
                : t.versions.musician.unavailable}
          </Text>
        ) : null}

        {/*
          A regeneration that has landed but not been chosen. Both options are
          buttons of equal weight: the app has no basis for preferring the new
          pair, and defaulting to it would silently discard something the user
          may have already decided they liked (§9).
        */}
        {hasPending ? (
          <Stack gap={2}>
            <Text variant="micro">{t.versions.musician.compareReady}</Text>
            <Row gap={2} align="center">
              <Button kind="primary" size="small" onClick={onKeepPending}>
                {t.versions.musician.keepNew}
              </Button>
              <Button kind="quiet" size="small" onClick={onDiscardPending}>
                {t.versions.musician.keepOld}
              </Button>
            </Row>
          </Stack>
        ) : (
          <Row gap={2} align="center">
            {busy ? (
              <Button kind="quiet" size="small" onClick={onCancel}>
                {t.versions.musician.cancel}
              </Button>
            ) : hasResult ? (
              <>
                <Button kind="quiet" size="small" onClick={onRegenerate}>
                  {t.versions.musician.tryAnother}
                </Button>
                <Text variant="micro" muted>
                  {t.versions.musician.tryAnotherHint}
                </Text>
              </>
            ) : (
              <Button kind="primary" size="small" onClick={error ? onRegenerate : onGenerate}>
                {error ? t.versions.musician.retry : t.versions.musician.start}
              </Button>
            )}
          </Row>
        )}
      </Stack>
    </Well>
  );
}
