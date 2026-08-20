'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreationMode } from '@contracts';
import {
  DRUM_SPECS,
  VOICE_SPECS,
  instrumentsForMode,
  previewInstrument,
  type InstrumentDefinition,
  type PlaybackHandle,
} from '@synthesis';
import { unlockAudio } from '@audio-core';
import { track } from '@/features/analytics/track';
import { useLocale } from '@/i18n/provider';
import styles from './InstrumentGallery.module.css';

export interface InstrumentGalleryProps {
  mode: CreationMode;
  selectedId: string;
  onSelect(id: string): void;
  onError?(error: unknown): void;
}

/**
 * US-0603 / US-0604 - the gallery.
 *
 * One preview at a time, always. Two instruments playing over each other tells
 * the user nothing about either, and the accessibility skill lists overlapping
 * previews as a failure mode in its own right.
 *
 * The preview control is a separate button inside the item rather than a
 * hover-to-play behaviour: hover previews are unreachable by keyboard, fire by
 * accident on a trackpad, and do not exist at all on touch.
 */
export function InstrumentGallery({
  mode,
  selectedId,
  onSelect,
  onError,
}: InstrumentGalleryProps) {
  const { locale, t } = useLocale();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const handleRef = useRef<PlaybackHandle | null>(null);
  const timerRef = useRef<number | null>(null);

  const instruments = instrumentsForMode(mode);

  const stopPreview = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPreviewing(null);
  }, []);

  const preview = useCallback(
    async (instrument: InstrumentDefinition) => {
      if (previewing === instrument.id) {
        stopPreview();
        return;
      }
      stopPreview();
      setLoading(instrument.id);
      try {
        const context = await unlockAudio();
        const handle = await previewInstrument(context, instrument.id);
        handleRef.current = handle;
        setPreviewing(instrument.id);
        track('instrument_previewed', { instrument: instrument.id });
        // The preview patterns are under two seconds; clearing the state after
        // that keeps the button from staying lit once the sound has stopped.
        timerRef.current = window.setTimeout(() => setPreviewing(null), 2000);
      } catch (error) {
        onError?.(error);
      } finally {
        setLoading(null);
      }
    },
    [previewing, stopPreview, onError],
  );

  useEffect(() => stopPreview, [stopPreview]);

  return (
    <ul className={styles.grid}>
      {instruments.map((instrument) => {
        const selected = instrument.id === selectedId;
        const isPreviewing = previewing === instrument.id;
        return (
          <li key={instrument.id}>
            <button
              type="button"
              className={[
                styles.item,
                selected ? styles.itemSelected : null,
                loading === instrument.id ? styles.itemLoading : null,
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(instrument.id)}
              aria-pressed={selected}
              style={{ inlineSize: '100%' }}
            >
              <SpectralFigure instrument={instrument} />
              <span className={styles.name}>{instrument.name[locale]}</span>
              <span className={styles.meta}>
                <span className={styles.familyLabel}>
                  {t.instruments.families[instrument.family]}
                </span>
                {selected ? <span className={styles.badge}>{t.instruments.selected}</span> : null}
              </span>
            </button>

            {/* Outside the selection button: nesting one button inside another
                is invalid HTML and breaks keyboard traversal. */}
            <button
              type="button"
              className={[styles.previewButton, isPreviewing ? styles.previewButtonActive : null]
                .filter(Boolean)
                .join(' ')}
              onClick={() => void preview(instrument)}
              aria-label={`${isPreviewing ? t.instruments.stopPreview : t.instruments.preview}: ${instrument.name[locale]}`}
            >
              {isPreviewing ? t.instruments.stopPreview : t.instruments.preview}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The instrument's own harmonic recipe, drawn.
 *
 * Melodic instruments show their partial amplitudes as a spectrum; kits show
 * their three voices as decay envelopes. Both are read directly from the same
 * tables the synthesiser uses, so the figure cannot drift away from the sound
 * it represents (D-0502: the signature is material, not illustration).
 */
function SpectralFigure({ instrument }: { instrument: InstrumentDefinition }) {
  const voice = VOICE_SPECS[instrument.id];
  const kit = DRUM_SPECS[instrument.id];

  if (kit) {
    const voices = [kit.kick, kit.snare, kit.hat];
    return (
      <svg className={styles.figure} viewBox="0 0 100 32" aria-hidden="true" preserveAspectRatio="none">
        {voices.map((spec, index) => {
          const width = Math.min(90, spec.toneDecaySec * 90 + spec.noiseDecaySec * 60 + 6);
          return (
            <rect
              key={index}
              x={4}
              y={4 + index * 9}
              width={width}
              height={4}
              rx={2}
              fill="currentColor"
              opacity={0.35 + index * 0.2}
            />
          );
        })}
      </svg>
    );
  }

  if (!voice) return <span className={styles.figure} aria-hidden="true" />;

  const peak = Math.max(...voice.partials);
  return (
    <svg className={styles.figure} viewBox="0 0 100 32" aria-hidden="true" preserveAspectRatio="none">
      {voice.partials.map((amplitude, index) => {
        const height = Math.max(1.5, (amplitude / peak) * 26);
        const x = 5 + index * (90 / voice.partials.length);
        return (
          <rect
            key={index}
            x={x}
            y={30 - height}
            width={Math.max(2, 90 / voice.partials.length - 3)}
            height={height}
            rx={1}
            fill="currentColor"
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}
