import type { ComponentType, ElementType, ReactNode } from 'react';
import styles from './Text.module.css';

/**
 * The resolved tag for a polymorphic `as` prop.
 *
 * TypeScript cannot check props against the whole `ElementType` union - it
 * collapses every prop to `never` - so the resolved tag is cast to a component
 * with an open prop bag. The *call sites* stay fully typed; only this one
 * internal hand-off is widened.
 */
type PolymorphicTag = ComponentType<Record<string, unknown> & { children?: ReactNode }>;


type TextVariant = 'display' | 'title' | 'heading' | 'body' | 'label' | 'micro';

interface TextProps {
  children: ReactNode;
  variant?: TextVariant;
  muted?: boolean;
  as?: ElementType;
  id?: string;
  className?: string;
}

export function Text({ children, variant = 'body', muted, as, id, className }: TextProps) {
  const resolved: ElementType =
    as ??
    (variant === 'display'
      ? 'h1'
      : variant === 'title'
        ? 'h2'
        : variant === 'heading'
          ? 'h3'
          : 'p');
  const Tag = resolved as PolymorphicTag;

  return (
    <Tag
      id={id}
      className={[styles[variant], muted ? styles.muted : null, className].filter(Boolean).join(' ')}
    >
      {children}
    </Tag>
  );
}

/**
 * Bidi isolation.
 *
 * Wraps a fragment whose direction differs from the surrounding text - a note
 * name, a BPM value, a filename, a URL - so the browser's bidi algorithm treats
 * it as one opaque unit. Without this, "منتشر شد: rhythmisoze.com/s/ab12" can
 * render with the slug reordered, which is not a cosmetic problem: the user
 * copies a URL that is not the URL.
 *
 * The bilingual skill names this explicitly: use bidi isolation, do not rely on
 * `text-align` or punctuation.
 */
export function Bdi({ children, dir }: { children: ReactNode; dir?: 'ltr' | 'rtl' | 'auto' }) {
  return (
    <bdi className={styles.bdi} dir={dir ?? 'auto'}>
      {children}
    </bdi>
  );
}

/**
 * A measurement the user reads as an instrument: BPM, elapsed time, note count.
 * Always LTR with tabular figures, in both locales.
 */
export function Readout({
  value,
  unit,
  small,
  label,
}: {
  value: string | number;
  unit?: string;
  small?: boolean;
  label?: string;
}) {
  return (
    <span
      className={[styles.readout, small ? styles.readoutSmall : null].filter(Boolean).join(' ')}
      aria-label={label}
    >
      {value}
      {unit ? (
        <>
          {' '}
          <span className={styles.unit}>{unit}</span>
        </>
      ) : null}
    </span>
  );
}

/** A small all-caps stage marker. Falls back to plain text in Persian. */
export function StageLabel({ children }: { children: ReactNode }) {
  return <span className={styles.stageLabel}>{children}</span>;
}

/** Content announced to assistive technology but not painted. */
export function VisuallyHidden({
  children,
  as = 'span',
}: {
  children: ReactNode;
  as?: ElementType;
}) {
  const Tag = as as PolymorphicTag;
  return <Tag className="visually-hidden">{children}</Tag>;
}

/**
 * A polite live region.
 *
 * `polite` rather than `assertive` throughout: recording and processing update
 * often, and an assertive region interrupts the screen reader mid-sentence
 * every time. The accessibility skill calls this out as spam.
 *
 * Callers are expected to pass a *stable, coarse* message. Announcing every
 * percent tick is the same problem in a different costume.
 */
export function LiveStatus({
  children,
  assertive = false,
}: {
  children: ReactNode;
  assertive?: boolean;
}) {
  return (
    <div
      className="visually-hidden"
      role="status"
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {children}
    </div>
  );
}
