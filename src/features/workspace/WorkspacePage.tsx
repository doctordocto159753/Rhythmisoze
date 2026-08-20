'use client';

import { useCallback, useEffect, useState } from 'react';
import { toAppError, type AppError } from '@contracts';
import { getInstrument } from '@synthesis';
import { Button } from '@/components/Button';
import { ErrorPanel } from '@/components/ErrorPanel';
import { Row, Stack, Well } from '@/components/Layout';
import { Bdi, Text } from '@/components/Text';
import { track } from '@/features/analytics/track';
import { formatDate, localePath } from '@/i18n';
import { useLocale } from '@/i18n/provider';
import {
  deleteSketch,
  listSketches,
  renameSketch,
  requestPersistence,
  storageStatus,
  type StorageStatus,
  type StoredSketch,
} from './db';
import styles from './WorkspacePage.module.css';

/**
 * US-0803..US-0805 / D-0601 - the local workspace.
 *
 * Sketches are shown as musical objects rather than table rows: each one
 * carries a small contour drawn from its own note data, so a returning user
 * recognises an idea by its shape before reading its name.
 *
 * Everything here is local. There is no account, no sync and no server call -
 * the page works with the network off.
 */
export function WorkspacePage() {
  const { locale, t } = useLocale();
  const [sketches, setSketches] = useState<StoredSketch[] | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<Pick<AppError, 'code' | 'recovery'> | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSketches(await listSketches());
      setStorage(await storageStatus());
      setError(null);
    } catch (caught) {
      const appError = toAppError(caught, 'storage_unavailable', 'reload');
      setError({ code: appError.code, recovery: appError.recovery });
      setSketches([]);
    }
  }, []);

  useEffect(() => {
    // The sketches live in IndexedDB, which cannot be read during render and
    // has no synchronous snapshot to subscribe to, so this is the one place a
    // mount effect genuinely loads state. `load` is async: nothing is set
    // synchronously in the effect body, and the lint rule cannot see that
    // across the callback boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    track('workspace_opened');
    // Asking for persistent storage here rather than on first record: by now
    // the user has sketches worth keeping, which is when a browser is most
    // likely to grant it.
    void requestPersistence();
  }, [load]);

  const rename = useCallback(
    async (id: string, title: string) => {
      try {
        await renameSketch(id, title);
        setRenaming(null);
        await load();
      } catch (caught) {
        const appError = toAppError(caught, 'storage_failed', 'retry');
        setError({ code: appError.code, recovery: appError.recovery });
      }
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteSketch(id);
        setConfirming(null);
        await load();
      } catch (caught) {
        const appError = toAppError(caught, 'storage_failed', 'retry');
        setError({ code: appError.code, recovery: appError.recovery });
      }
    },
    [load],
  );

  return (
    <div className="stage">
      <Stack gap={5}>
        <Row justify="between" gap={3}>
          <Text variant="title" as="h1">
            {t.workspace.title}
          </Text>
          {sketches !== null && sketches.length > 0 ? (
            <Text variant="micro" muted>
              {t.workspace.count(sketches.length)}
            </Text>
          ) : null}
        </Row>

        {error ? <ErrorPanel error={error} onDismiss={() => setError(null)} /> : null}

        {storage?.low === true ? (
          <Well tone="danger">
            <Stack gap={2}>
              <Text variant="heading" as="h2">
                {t.workspace.storageWarning}
              </Text>
              <Text variant="micro" muted>
                {t.workspace.storageWarningBody}
              </Text>
            </Stack>
          </Well>
        ) : null}

        {sketches === null ? (
          <Text muted>{t.common.loading}</Text>
        ) : sketches.length === 0 ? (
          <Well>
            <Stack gap={3} align="start">
              <Text variant="heading" as="h2">
                {t.workspace.empty}
              </Text>
              {/* The empty state teaches the first action rather than
                  apologising for being empty (US-0803). */}
              <Button kind="accent" onClick={() => (window.location.href = localePath(locale))}>
                {t.workspace.emptyAction}
              </Button>
            </Stack>
          </Well>
        ) : (
          <ul className={styles.list}>
            {sketches.map((sketch) => {
              const instrument = getInstrument(sketch.instrumentId);
              return (
                <li key={sketch.id} className={styles.item}>
                  <Contour sketch={sketch} />

                  <div className={styles.body}>
                    {renaming === sketch.id ? (
                      <form
                        className={styles.renameRow}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const input = event.currentTarget.elements.namedItem(
                            'title',
                          ) as HTMLInputElement;
                          void rename(sketch.id, input.value);
                        }}
                      >
                        <label className="visually-hidden" htmlFor={`rename-${sketch.id}`}>
                          {t.workspace.renameLabel}
                        </label>
                        <input
                          id={`rename-${sketch.id}`}
                          name="title"
                          className={styles.renameInput}
                          defaultValue={sketch.title}
                          maxLength={80}
                          autoFocus
                        />
                        <Button kind="primary" size="small" type="submit">
                          {t.common.save}
                        </Button>
                        <Button kind="ghost" size="small" onClick={() => setRenaming(null)}>
                          {t.common.cancel}
                        </Button>
                      </form>
                    ) : (
                      <>
                        <span className={styles.itemTitle}>
                          <bdi dir="auto">{sketch.title || t.workspace.untitled}</bdi>
                        </span>
                        <span className={styles.itemMeta}>
                          <bdi dir="auto">{instrument?.name[locale] ?? sketch.instrumentId}</bdi>
                          {' · '}
                          <Bdi dir="ltr">{sketch.bpm} BPM</Bdi>
                          {' · '}
                          {t.workspace.savedAt(formatDate(sketch.updatedAt, locale))}
                        </span>
                      </>
                    )}
                  </div>

                  <div className={styles.actions}>
                    <Button kind="ghost" size="small" onClick={() => setRenaming(sketch.id)}>
                      {t.workspace.rename}
                    </Button>
                    <Button kind="ghost" size="small" onClick={() => setConfirming(sketch.id)}>
                      {t.workspace.delete}
                    </Button>
                  </div>

                  {/* US-0804: deletion is a deliberate second step, and the copy
                      says what it does and does not touch. */}
                  {confirming === sketch.id ? (
                    <Well tone="danger" padding="tight" className={styles.confirm}>
                      <Stack gap={2}>
                        <Text variant="label" as="p">
                          {t.workspace.deleteConfirm(sketch.title || t.workspace.untitled)}
                        </Text>
                        <Text variant="micro" muted>
                          {t.workspace.deleteConfirmBody}
                        </Text>
                        <Row gap={2}>
                          <Button
                            kind="danger"
                            size="small"
                            onClick={() => void remove(sketch.id)}
                          >
                            {t.workspace.delete}
                          </Button>
                          <Button kind="ghost" size="small" onClick={() => setConfirming(null)}>
                            {t.workspace.cancel}
                          </Button>
                        </Row>
                      </Stack>
                    </Well>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Stack>
    </div>
  );
}

/**
 * A sketch's contour: its melodic shape, or its rhythm density, in one figure.
 *
 * Drawn from the stored note data rather than from a thumbnail image, so it
 * costs nothing to store and is always in sync with the sketch it describes.
 */
function Contour({ sketch }: { sketch: StoredSketch }) {
  const notes = sketch.rawNotes;
  const drums = sketch.rawDrums;

  if (sketch.mode === 'rhythm' || notes.length === 0) {
    const marks = drums.slice(0, 32);
    const span = Math.max(sketch.durationSec, 0.001);
    return (
      <svg className={styles.contour} viewBox="0 0 100 40" aria-hidden="true">
        {marks.map((hit, index) => (
          <rect
            key={index}
            x={(hit.timeSec / span) * 96 + 2}
            y={hit.drum === 'kick' ? 26 : hit.drum === 'snare' ? 16 : 6}
            width="2"
            height="8"
            rx="1"
            fill="currentColor"
            opacity={0.35 + (hit.velocity / 127) * 0.5}
          />
        ))}
      </svg>
    );
  }

  const pitches = notes.map((note) => note.pitch);
  const low = Math.min(...pitches);
  const high = Math.max(...pitches);
  const range = Math.max(1, high - low);
  const span = Math.max(sketch.durationSec, 0.001);
  const points = notes
    .slice(0, 64)
    .map((note) => `${(note.startSec / span) * 96 + 2},${36 - ((note.pitch - low) / range) * 32}`)
    .join(' ');

  return (
    <svg className={styles.contour} viewBox="0 0 100 40" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
    </svg>
  );
}
