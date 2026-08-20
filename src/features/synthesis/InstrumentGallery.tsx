'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreationMode } from '@contracts';
import {
  instrumentsForMode,
  preloadInstrument,
  previewInstrument,
  type InstrumentDefinition,
  type PlaybackHandle,
} from '@synthesis';
import { unlockAudio } from '@audio-core';
import { track } from '@/features/analytics/track';
import { localizeDigits } from '@/i18n';
import { useLocale } from '@/i18n/provider';
import styles from './InstrumentGallery.module.css';

export interface InstrumentGalleryProps {
  mode: CreationMode;
  selectedId: string;
  onSelect(id: string): void;
  onError?(error: unknown): void;
}

type PreparationResult = Awaited<ReturnType<typeof preloadInstrument>>;

type PreparationState =
  | { status: 'loading'; progress: number }
  | { status: 'ready' | 'fallback' | 'error' };

const FLUID_R3_SOURCE =
  'https://github.com/gleitz/midi-js-soundfonts/tree/gh-pages/FluidR3_GM';
const VSCO_CE_SOURCE = 'https://github.com/sgossner/VSCO-2-CE';

/**
 * US-0603 / US-0604 - the gallery.
 *
 * Selecting a recorded instrument commits the choice before its pack begins to
 * load. Preparation is tracked per instrument, so another card remains fully
 * usable and an instrument that has already loaded stays visibly ready.
 *
 * Preview and selection remain sibling buttons. Aside from producing valid
 * HTML, this gives keyboard users two explicit decisions: choose the character
 * of the sound, or briefly hear it.
 */
export function InstrumentGallery({
  mode,
  selectedId,
  onSelect,
  onError,
}: InstrumentGalleryProps) {
  const { locale, t } = useLocale();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [preparation, setPreparation] = useState<Record<string, PreparationState>>({});
  const handleRef = useRef<PlaybackHandle | null>(null);
  const timerRef = useRef<number | null>(null);
  const previewRequestRef = useRef(0);
  const preparedRef = useRef(new Map<string, PreparationResult>());
  const inFlightRef = useRef(new Map<string, Promise<PreparationResult>>());
  const mountedRef = useRef(true);

  const instruments = instrumentsForMode(mode);

  const stopPreview = useCallback(() => {
    previewRequestRef.current += 1;
    handleRef.current?.stop();
    handleRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (mountedRef.current) {
      setPreviewing(null);
      setPendingPreview(null);
    }
  }, []);

  const markLoadFailure = useCallback(
    (instrumentId: string, error: unknown) => {
      if (!mountedRef.current) return;
      setPreparation((current) => ({
        ...current,
        [instrumentId]: { status: 'error' },
      }));
      onError?.(error);
    },
    [onError],
  );

  const prepare = useCallback(
    (context: BaseAudioContext, instrument: InstrumentDefinition): Promise<PreparationResult> => {
      const prepared = preparedRef.current.get(instrument.id);
      if (prepared) return Promise.resolve(prepared);

      const inFlight = inFlightRef.current.get(instrument.id);
      if (inFlight) return inFlight;

      if (mountedRef.current) {
        setPreparation((current) => ({
          ...current,
          [instrument.id]: { status: 'loading', progress: 0 },
        }));
      }

      const operation = preloadInstrument(context, instrument.id, {
        onProgress(fraction) {
          const progress = Math.max(0, Math.min(1, fraction));
          if (!mountedRef.current) return;
          setPreparation((current) => {
            const previous = current[instrument.id];
            if (previous?.status !== 'loading') return current;
            return {
              ...current,
              [instrument.id]: {
                status: 'loading',
                progress: Math.max(previous.progress, progress),
              },
            };
          });
        },
      })
        .then((result) => {
          preparedRef.current.set(instrument.id, result);
          if (mountedRef.current) {
            setPreparation((current) => ({
              ...current,
              [instrument.id]: { status: result.fellBack ? 'fallback' : 'ready' },
            }));
          }
          return result;
        })
        .catch((error: unknown) => {
          markLoadFailure(instrument.id, error);
          throw error;
        })
        .finally(() => {
          inFlightRef.current.delete(instrument.id);
        });

      inFlightRef.current.set(instrument.id, operation);
      return operation;
    },
    [markLoadFailure],
  );

  const select = useCallback(
    (instrument: InstrumentDefinition) => {
      onSelect(instrument.id);
      if (instrument.type !== 'sample') return;

      // The choice is already committed above. Loading is deliberately
      // background work and never gates selection elsewhere in the gallery.
      void (async () => {
        let context: AudioContext;
        try {
          context = await unlockAudio();
        } catch (error) {
          markLoadFailure(instrument.id, error);
          return;
        }

        // `prepare` records and reports its own failure for every waiter.
        try {
          await prepare(context, instrument);
        } catch {
          // The visible error state and host callback were set by `prepare`.
        }
      })();
    },
    [markLoadFailure, onSelect, prepare],
  );

  const preview = useCallback(
    async (instrument: InstrumentDefinition) => {
      if (previewing === instrument.id || pendingPreview === instrument.id) {
        stopPreview();
        return;
      }

      stopPreview();
      const requestId = previewRequestRef.current;
      setPendingPreview(instrument.id);

      let context: AudioContext;
      try {
        context = await unlockAudio();
      } catch (error) {
        if (previewRequestRef.current === requestId) setPendingPreview(null);
        markLoadFailure(instrument.id, error);
        return;
      }

      if (previewRequestRef.current !== requestId) return;
      try {
        await prepare(context, instrument);
      } catch {
        if (previewRequestRef.current === requestId) setPendingPreview(null);
        return;
      }

      if (previewRequestRef.current !== requestId) return;
      try {
        const handle = await previewInstrument(context, instrument.id);
        if (previewRequestRef.current !== requestId) {
          handle.stop();
          return;
        }

        handleRef.current = handle;
        setPendingPreview(null);
        setPreviewing(instrument.id);
        track('instrument_previewed', { instrument: instrument.id });
        // Preview patterns are under two seconds. Clearing the state after the
        // gesture ends prevents a stale stop label from lingering.
        timerRef.current = window.setTimeout(() => {
          if (mountedRef.current && previewRequestRef.current === requestId) {
            timerRef.current = null;
            setPreviewing(null);
          }
        }, 2000);
      } catch (error) {
        if (mountedRef.current && previewRequestRef.current === requestId) {
          setPendingPreview(null);
          onError?.(error);
        }
      }
    },
    [markLoadFailure, onError, pendingPreview, prepare, previewing, stopPreview],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewRequestRef.current += 1;
      handleRef.current?.stop();
      handleRef.current = null;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  return (
    <div className={styles.gallery}>
      <ul className={styles.grid}>
        {instruments.map((instrument) => {
          const selected = instrument.id === selectedId;
          const isPreviewing = previewing === instrument.id;
          const isPendingPreview = pendingPreview === instrument.id;
          const loadState = preparation[instrument.id];
          const isLoading = loadState?.status === 'loading';
          const percentage = isLoading ? Math.round(loadState.progress * 100) : 0;
          const localizedPercentage = localizeDigits(percentage, locale);
          const detailId = `instrument-${instrument.id}-details`;

          return (
            <li
              key={instrument.id}
              className={[
                styles.card,
                instrument.type === 'sample' ? styles.recordedCard : null,
                selected ? styles.cardSelected : null,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className={styles.item}
                onClick={() => select(instrument)}
                aria-pressed={selected}
                aria-describedby={detailId}
              >
                <span className={styles.sourceLine}>
                  <span className={styles.sourceLabel}>
                    {t.instruments.sources[instrument.type]}
                  </span>
                  {instrument.samplePackBytes !== undefined ? (
                    <bdi className={styles.packSize} dir="auto">
                      {t.instruments.sampleSize(formatMegabytes(instrument.samplePackBytes, locale))}
                    </bdi>
                  ) : null}
                </span>

                <SpectralFigure profile={instrument.visualProfile} />

                <span className={styles.titleLine}>
                  <span className={styles.name}>{instrument.name[locale]}</span>
                  {selected ? <span className={styles.badge}>{t.instruments.selected}</span> : null}
                </span>

                <span className={styles.moodList} aria-label={instrument.mood[locale].join(', ')}>
                  {instrument.mood[locale].slice(0, 3).map((word) => (
                    <span className={styles.moodWord} key={word}>
                      {word}
                    </span>
                  ))}
                </span>

                <span className={styles.bestFor} id={detailId}>
                  {t.instruments.bestFor(
                    instrument.bestFor[locale].join(locale === 'fa' ? '، ' : ', '),
                  )}
                </span>
              </button>

              <div className={styles.cardFooter}>
                {isLoading ? (
                  <div className={styles.loadStatus}>
                    <progress
                      className={styles.progress}
                      value={loadState.progress}
                      max={1}
                      aria-label={`${instrument.name[locale]}: ${t.instruments.preparing(localizedPercentage)}`}
                    />
                    <span className={styles.statusText} aria-live="polite" aria-atomic="true">
                      {t.instruments.preparing(localizedPercentage)}
                    </span>
                  </div>
                ) : loadState ? (
                  <span
                    className={[
                      styles.statusText,
                      loadState.status === 'error' ? styles.statusError : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-live="polite"
                  >
                    {loadState.status === 'fallback'
                      ? t.instruments.fallbackReady
                      : loadState.status === 'error'
                        ? t.instruments.loadFailed
                        : t.instruments.ready}
                  </span>
                ) : (
                  <span className={styles.statusPlaceholder} aria-hidden="true" />
                )}

                {/* Sibling of the selection button: never nest interactive controls. */}
                <button
                  type="button"
                  className={[
                    styles.previewButton,
                    isPreviewing || isPendingPreview ? styles.previewButtonActive : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => void preview(instrument)}
                  aria-busy={isPendingPreview}
                  aria-label={`${
                    isPreviewing
                      ? t.instruments.stopPreview
                      : isPendingPreview
                        ? t.common.cancel
                        : t.instruments.preview
                  }: ${instrument.name[locale]}`}
                >
                  {isPreviewing
                    ? t.instruments.stopPreview
                    : isPendingPreview
                      ? t.common.cancel
                      : t.instruments.preview}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <details className={styles.credits}>
        <summary className={styles.creditsSummary}>{t.instruments.credits.title}</summary>
        <div className={styles.creditsBody}>
          <p className={styles.creditLine}>
            <bdi dir="ltr">FluidR3_GM · CC BY 3.0</bdi>
            <span> — {t.instruments.credits.soundfontBy} </span>
            <bdi dir="ltr">Frank Wen</bdi>
            <span>; {t.instruments.credits.browserFilesBy} </span>
            <bdi dir="ltr">Benjamin Gleitzman</bdi>
            <span>. </span>
            <a
              className={styles.creditLink}
              href={FLUID_R3_SOURCE}
              target="_blank"
              rel="noreferrer"
            >
              {t.instruments.credits.sourceLink}
            </a>
          </p>
          <p className={styles.creditLine}>
            <bdi dir="ltr">VSCO 2 Community Edition · CC0 1.0</bdi>
            <span> — {t.instruments.credits.recordedBy} </span>
            <bdi dir="ltr">Sam Gossner</bdi>
            <span> {t.instruments.credits.and} </span>
            <bdi dir="ltr">Simon Dalzell</bdi>
            <span>. </span>
            <a
              className={styles.creditLink}
              href={VSCO_CE_SOURCE}
              target="_blank"
              rel="noreferrer"
            >
              {t.instruments.credits.sourceLink}
            </a>
          </p>
        </div>
      </details>
    </div>
  );
}

/** A neutral registry fingerprint. Time/order always runs left-to-right. */
function SpectralFigure({ profile }: { profile: readonly number[] }) {
  return (
    <span className={styles.figure} dir="ltr" aria-hidden="true">
      {profile.map((amplitude, index) => (
        <span
          className={styles.figureBar}
          key={index}
          style={{ blockSize: `${Math.max(8, Math.min(100, amplitude * 100))}%` }}
        />
      ))}
    </span>
  );
}

function formatMegabytes(bytes: number, locale: 'en' | 'fa'): string {
  const megabytes = bytes / (1024 * 1024);
  const value = megabytes >= 10 ? Math.round(megabytes).toString() : megabytes.toFixed(1);
  return localizeDigits(value.replace(/\.0$/, ''), locale);
}
