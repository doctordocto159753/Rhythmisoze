'use client';

import { useId } from 'react';
import styles from './Slider.module.css';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Human-readable value shown beside the label and announced to AT. */
  valueText: string;
  /** Renders the raw-to-clean gradient and the endpoint captions. */
  continuum?: boolean;
  startLabel?: string;
  endLabel?: string;
  onChange(value: number): void;
  /** Fired when the drag ends, for work too expensive to run per pixel. */
  onCommit?(value: number): void;
}

/**
 * A labelled range control.
 *
 * `aria-valuetext` carries the word, not the number: a screen-reader user
 * hearing "62" learns nothing about the cleanup control, while "balanced" is
 * the same information the sighted user gets.
 *
 * `onChange` fires continuously for immediate visual feedback; `onCommit` fires
 * once on release. The review screen re-runs retouch on change (it is pure and
 * cheap) but only re-renders audio on commit.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  valueText,
  continuum,
  startLabel,
  endLabel,
  onChange,
  onCommit,
}: SliderProps) {
  const id = useId();
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <div className={[styles.field, continuum ? styles.continuum : null].filter(Boolean).join(' ')}>
      <div className={styles.header}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <span className={styles.value}>{valueText}</span>
      </div>

      <div className={styles.track} style={{ ['--fill' as string]: `${fill}%` }}>
        <input
          id={id}
          className={styles.input}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-valuetext={valueText}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerUp={() => onCommit?.(value)}
          onKeyUp={() => onCommit?.(value)}
          onBlur={() => onCommit?.(value)}
        />
        <span className={styles.rail} aria-hidden="true">
          <span className={styles.fill} />
        </span>
        <span className={styles.thumb} aria-hidden="true" />
      </div>

      {startLabel && endLabel ? (
        <div className={styles.ends} aria-hidden="true">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
