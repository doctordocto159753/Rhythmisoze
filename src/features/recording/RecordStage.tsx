'use client';

import { useEffect, useRef } from 'react';
import type { LevelSnapshot } from '@audio-core';
import { Button } from '@/components/Button';
import { Stack } from '@/components/Layout';
import { LiveStatus, Text, VisuallyHidden } from '@/components/Text';
import { formatDuration } from '@/i18n';
import { useMessages } from '@/i18n/provider';
import styles from './RecordStage.module.css';

export interface RecordStageProps {
  /** `armed` is the brief moment between granting the microphone and capture. */
  phase: 'armed' | 'recording';
  level: LevelSnapshot | null;
  elapsedSec: number;
  maxSec: number;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}

/**
 * US-0206 / US-0207 - the recording lifecycle and its live feedback.
 *
 * Two things every state must show, because the accessibility skill requires
 * each of them not to be sound-only or canvas-only:
 *  - that the microphone is receiving (level, and a text status);
 *  - how much time is left (a figure, not only a bar).
 *
 * There used to be a third — where the count-in had got to. Recording now
 * begins the moment the microphone opens, so there is no bar to wait through
 * and nothing to count against.
 */
export function RecordStage({
  phase,
  level,
  elapsedSec,
  maxSec,
  onStart,
  onStop,
  onCancel,
}: RecordStageProps) {
  const t = useMessages();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !level) return;
    drawWaveform(canvas, level);
  }, [level]);

  const remaining = Math.max(0, maxSec - elapsedSec);
  const fraction = Math.min(1, elapsedSec / maxSec);
  // The last ten seconds change colour: a rule of thirds would be arbitrary,
  // ten seconds is roughly a musical phrase.
  const nearLimit = remaining <= 10;

  const guidance =
    level === null
      ? null
      : level.clipping
        ? { text: t.record.tooLoud, className: styles.guidanceLoud }
        : level.rms < 0.008
          ? { text: t.record.tooQuiet, className: styles.guidanceQuiet }
          : null;

  return (
    <div className={styles.stage}>
      {phase === 'armed' ? (
        <Stack gap={4} align="center">
          <button
            type="button"
            className={styles.recordButton}
            onClick={onStart}
            aria-label={t.a11y.recordButton}
          >
            <span className={styles.recordGlyph} aria-hidden="true" />
          </button>
          <Text variant="label" as="p">
            {t.record.opening}
          </Text>
          <LiveStatus>{t.record.opening}</LiveStatus>
        </Stack>
      ) : null}

      {phase === 'recording' ? (
        <>
          <Stack gap={4} align="center">
            <button
              type="button"
              className={styles.recordButton}
              onClick={onStop}
              aria-label={t.a11y.stopButton}
            >
              <span className={styles.stopGlyph} aria-hidden="true" />
            </button>
            <Text variant="label" as="p">
              {t.record.stop}
            </Text>
          </Stack>

          <div className={styles.meterWrap}>
            <canvas
              ref={canvasRef}
              className={styles.waveform}
              width={680}
              height={120}
              role="img"
              aria-label={t.a11y.waveform}
            />
            {/* The canvas carries no information a screen reader can reach, so
                the same facts are stated in text (accessibility skill). */}
            <VisuallyHidden>
              {t.a11y.levelValue(Math.round((level?.rms ?? 0) * 100))}
            </VisuallyHidden>
          </div>

          <div className={styles.timeBar}>
            <div
              className={[styles.timeFill, nearLimit ? styles.timeFillWarn : null]
                .filter(Boolean)
                .join(' ')}
              style={{ inlineSize: `${fraction * 100}%` }}
            />
          </div>

          <div className={styles.timeRow}>
            <span className={styles.remaining}>{formatDuration(elapsedSec, { precise: true })}</span>
            <span className={styles.remaining}>
              {t.record.remaining(formatDuration(remaining, { precise: true }))}
            </span>
          </div>

          <p className={[styles.guidance, guidance?.className].filter(Boolean).join(' ')}>
            {guidance?.text ?? ''}
          </p>
          <LiveStatus>{t.record.recording}</LiveStatus>
        </>
      ) : null}

      {phase !== 'armed' ? (
        <Button kind="ghost" onClick={onCancel}>
          {t.record.cancel}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Draws the live waveform.
 *
 * Deliberately cheap: one path, no gradients, no shadows, no per-frame layout.
 * US-0207 requires that the visualisation not add audio scheduling jitter, and
 * the surest way to honour that is for the draw to be trivial.
 */
function drawWaveform(canvas: HTMLCanvasElement, level: LevelSnapshot): void {
  const context = canvas.getContext('2d');
  if (!context) return;

  const width = canvas.width;
  const height = canvas.height;
  const middle = height / 2;
  context.clearRect(0, 0, width, height);

  const style = getComputedStyle(canvas);
  const stroke = style.getPropertyValue('--color-recording').trim() || '#a83a28';

  context.strokeStyle = stroke;
  context.lineWidth = 2;
  context.lineCap = 'round';
  context.beginPath();

  const points = level.waveform.length;
  const step = width / points;
  for (let i = 0; i < points; i += 1) {
    const amplitude = Math.min(1, (level.waveform[i] as number) * 1.6);
    const half = amplitude * (middle - 6);
    const x = i * step + step / 2;
    context.moveTo(x, middle - half);
    context.lineTo(x, middle + half);
  }
  context.stroke();
}
