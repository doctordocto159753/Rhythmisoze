'use client';

import { useId } from 'react';
import styles from './Choice.module.css';

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  hint?: string;
}

export interface ChoiceProps<T extends string> {
  legend: string;
  options: ReadonlyArray<ChoiceOption<T>>;
  value: T;
  disabled?: boolean;
  /** Renders as a joined segmented control rather than separate panels. */
  compact?: boolean;
  onChange(value: T): void;
}

/**
 * A single-select group.
 *
 * Two presentations, one behaviour: the panelled form for the Melody/Rhythm
 * decision, which deserves space and an explanation, and the compact form for
 * secondary choices like meter.
 */
export function Choice<T extends string>({
  legend,
  options,
  value,
  disabled,
  compact,
  onChange,
}: ChoiceProps<T>) {
  const name = useId();

  return (
    <fieldset
      className={[styles.group, compact ? styles.compact : null].filter(Boolean).join(' ')}
    >
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.options}>
        {options.map((option) => (
          <label key={option.value} className={styles.option}>
            <input
              className={styles.input}
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span className={styles.optionTitle}>{option.title}</span>
            {option.hint ? <span className={styles.optionHint}>{option.hint}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
