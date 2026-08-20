'use client';

import { useEffect, useRef, useState } from 'react';
import { BPM_MAX, BPM_MIN, type Meter } from '@contracts';
import { Button } from '@/components/Button';
import { Choice } from '@/components/Choice';
import { Row, Stack } from '@/components/Layout';
import { Slider } from '@/components/Slider';
import { Readout, Text, VisuallyHidden } from '@/components/Text';
import { useMessages } from '@/i18n/provider';
import type { BeatInfo } from '@audio-core';
import styles from './TempoPanel.module.css';

export interface TempoPanelProps {
  bpm: number | null;
  tapCount: number;
  meter: Meter;
  metronomeMuted: boolean;
  beat: BeatInfo | null;
  disabled?: boolean;
  onTap(): void;
  onBpmChange(bpm: number): void;
  onMeterChange(meter: Meter): void;
  onToggleMetronome(): void;
  /** Called on hover/focus so the model download overlaps this stage. */
  onWarm?(): void;
}

const TAPS_NEEDED = 4;

/**
 * US-0201 / US-0202 - tap tempo and manual adjustment together.
 *
 * The pad and the slider are two views of one value, not two settings. Tapping
 * updates the slider; dragging the slider does not clear the taps, because a
 * user who taps 118 and nudges to 120 has not stopped meaning 120.
 *
 * The tap pad is a real `<button>`: space and enter work, and a keyboard user
 * can tap a tempo exactly as a pointer user can (D-0301 acceptance criterion).
 */
export function TempoPanel({
  bpm,
  tapCount,
  meter,
  metronomeMuted,
  beat,
  disabled,
  onTap,
  onBpmChange,
  onMeterChange,
  onToggleMetronome,
  onWarm,
}: TempoPanelProps) {
  const t = useMessages();
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);

  const handleTap = (): void => {
    onTap();
    setFlash(true);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    // 90 ms: long enough to see, short enough that a fast tapper still gets one
    // flash per tap rather than a smear.
    flashTimer.current = window.setTimeout(() => setFlash(false), 90);
  };

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const remaining = Math.max(0, TAPS_NEEDED - tapCount);
  const beatDuration = bpm !== null ? `${Math.round(60000 / bpm)}ms` : '600ms';

  return (
    <div className={styles.panel} style={{ ['--beat-duration' as string]: beatDuration }}>
      <div>
        <button
          type="button"
          className={[styles.pad, flash ? styles.padActive : null].filter(Boolean).join(' ')}
          onPointerDown={handleTap}
          onKeyDown={(event) => {
            // Handled on keydown, not on click, so the pulse lands with the key
            // press rather than after the browser's synthesised click.
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              handleTap();
            }
          }}
          onMouseEnter={onWarm}
          onFocus={onWarm}
          disabled={disabled}
          aria-label={t.tempo.tapPrompt}
        >
          {/* Re-keyed on each beat so the ring animation restarts exactly once
              per click instead of looping independently of the audio. */}
          {beat ? <span key={beat.index} className={styles.ring} aria-hidden="true" /> : null}
          {bpm === null ? (
            <>
              <span className={styles.padCount}>{remaining}</span>
              <span className={styles.padLabel}>{t.tempo.tapPrompt}</span>
            </>
          ) : (
            <>
              <span className={styles.padCount}>{bpm}</span>
              <span className={styles.padLabel}>{t.tempo.tapAgain}</span>
            </>
          )}
        </button>
      </div>

      <Stack gap={4}>
        <Stack gap={1}>
          <Row gap={3} justify="between">
            <Text variant="label" as="span">
              {t.tempo.label}
            </Text>
            {bpm !== null ? <Readout value={bpm} unit={t.tempo.unit} small /> : null}
          </Row>

          <Slider
            label={t.tempo.sliderLabel}
            value={bpm ?? 100}
            min={BPM_MIN}
            max={BPM_MAX}
            step={1}
            disabled={disabled}
            valueText={bpm === null ? t.tempo.notSet : t.units.bpm(bpm)}
            onChange={onBpmChange}
          />
        </Stack>

        {/* Q-B3: user-selectable meter from day one. */}
        <Choice<'3' | '4' | '6'>
          legend={t.tempo.meter}
          compact
          value={String(meter.beatsPerBar) as '3' | '4' | '6'}
          disabled={disabled}
          options={[
            { value: '3', title: '3' },
            { value: '4', title: '4' },
            { value: '6', title: '6' },
          ]}
          onChange={(value) =>
            onMeterChange({ beatsPerBar: Number(value), beatUnit: value === '6' ? 8 : 4 })
          }
        />

        <Row gap={3} justify="between">
          <Button
            kind="quiet"
            size="small"
            onClick={onToggleMetronome}
            aria-pressed={!metronomeMuted}
          >
            {metronomeMuted ? t.tempo.metronomeOff : t.tempo.metronomeOn}
          </Button>

          {/* D-0302: the pulse stays visible when the click is muted, because
              the user may not be able to hear it (accessibility skill). */}
          <div className={styles.beats} aria-hidden="true">
            {Array.from({ length: meter.beatsPerBar }, (_, index) => {
              const active = beat !== null && beat.beatInBar === index;
              return (
                <span
                  key={index}
                  className={[
                    styles.beatDot,
                    index === 0 ? styles.beatDotDownbeat : null,
                    active ? styles.beatDotActive : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />
              );
            })}
          </div>
          {beat ? (
            <VisuallyHidden>{t.a11y.beat(beat.beatInBar + 1, meter.beatsPerBar)}</VisuallyHidden>
          ) : null}
        </Row>

        <p className={styles.why}>{t.tempo.why}</p>
      </Stack>
    </div>
  );
}
