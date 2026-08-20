'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonKind = 'primary' | 'quiet' | 'ghost' | 'accent' | 'danger';
export type ButtonSize = 'small' | 'medium' | 'large';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  kind?: ButtonKind;
  size?: ButtonSize;
  block?: boolean;
  /** Shows a working indicator and blocks interaction without changing width. */
  busy?: boolean;
  icon?: ReactNode;
}

/**
 * The one button in the system.
 *
 * `type` defaults to `button`: a bare `<button>` inside a form submits it, and
 * a stray submit in the middle of a recording flow reloads the page and loses
 * the take.
 */
export function Button({
  kind = 'quiet',
  size = 'medium',
  block = false,
  busy = false,
  icon,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[kind],
    size !== 'medium' ? styles[size] : null,
    block ? styles.block : null,
    busy ? styles.busy : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {icon}
      {children}
      {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
    </button>
  );
}
