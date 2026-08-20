import type { ComponentType, CSSProperties, ElementType, ReactNode } from 'react';
import styles from './Layout.module.css';

/**
 * The resolved tag for a polymorphic `as` prop.
 *
 * TypeScript cannot check props against the whole `ElementType` union - it
 * collapses every prop to `never` - so the resolved tag is cast to a component
 * with an open prop bag. The *call sites* stay fully typed; only this one
 * internal hand-off is widened.
 */
type PolymorphicTag = ComponentType<Record<string, unknown> & { children?: ReactNode }>;


type Gap = 1 | 2 | 3 | 4 | 5 | 6 | 7;

interface FlexProps {
  children: ReactNode;
  gap?: Gap;
  align?: 'start' | 'center' | 'stretch';
  justify?: 'between' | 'center' | 'end';
  grow?: boolean;
  nowrap?: boolean;
  as?: ElementType;
  style?: CSSProperties;
  id?: string;
  className?: string;
}

function classes(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(' ');
}

const GAP: Record<Gap, string> = {
  1: styles.gap1 as string,
  2: styles.gap2 as string,
  3: styles.gap3 as string,
  4: styles.gap4 as string,
  5: styles.gap5 as string,
  6: styles.gap6 as string,
  7: styles.gap7 as string,
};

/** Vertical rhythm. Nothing decorative - spacing only. */
export function Stack({
  children,
  gap = 4,
  align,
  justify,
  grow,
  as = 'div',
  style,
  id,
  className,
}: FlexProps) {
  const Tag = as as PolymorphicTag;
  return (
    <Tag
      id={id}
      style={style}
      className={classes(
        styles.stack,
        GAP[gap],
        align === 'center' && styles.alignCenter,
        align === 'start' && styles.alignStart,
        align === 'stretch' && styles.alignStretch,
        justify === 'between' && styles.justifyBetween,
        justify === 'center' && styles.justifyCenter,
        justify === 'end' && styles.justifyEnd,
        grow && styles.grow,
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Horizontal grouping along the inline axis, so it flips with the locale. */
export function Row({
  children,
  gap = 3,
  align = 'center',
  justify,
  grow,
  nowrap,
  as = 'div',
  style,
  id,
  className,
}: FlexProps) {
  const Tag = as as PolymorphicTag;
  return (
    <Tag
      id={id}
      style={style}
      className={classes(
        styles.row,
        GAP[gap],
        align === 'center' && styles.alignCenter,
        align === 'start' && styles.alignStart,
        align === 'stretch' && styles.alignStretch,
        justify === 'between' && styles.justifyBetween,
        justify === 'center' && styles.justifyCenter,
        justify === 'end' && styles.justifyEnd,
        nowrap && styles.wrapNone,
        grow && styles.grow,
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export type SurfaceTone = 'neutral' | 'recording' | 'processing' | 'success' | 'danger' | 'accent';

interface WellProps {
  children: ReactNode;
  tone?: SurfaceTone;
  padding?: 'normal' | 'tight' | 'flush';
  as?: ElementType;
  id?: string;
  className?: string;
  style?: CSSProperties;
  role?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-live'?: 'polite' | 'assertive' | 'off';
}

const TONE: Record<SurfaceTone, string | null> = {
  neutral: null,
  recording: styles.toneRecording as string,
  processing: styles.toneProcessing as string,
  success: styles.toneSuccess as string,
  danger: styles.toneDanger as string,
  accent: styles.toneAccent as string,
};

/**
 * A recess in the ground. The default container for grouped controls.
 * Explicitly not a card: it has no shadow and does not float.
 */
export function Well({
  children,
  tone = 'neutral',
  padding = 'normal',
  as = 'div',
  className,
  ...rest
}: WellProps) {
  const Tag = as as PolymorphicTag;
  return (
    <Tag
      {...rest}
      className={classes(
        styles.well,
        padding === 'tight' && styles.wellTight,
        padding === 'flush' && styles.wellFlush,
        TONE[tone],
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * The single lifted plane on a screen (invariant 2).
 * Using more than one on a page is a design regression, not a styling choice.
 */
export function Raised({ children, as = 'div', className, ...rest }: WellProps) {
  const Tag = as as PolymorphicTag;
  return (
    <Tag {...rest} className={classes(styles.raised, className)}>
      {children}
    </Tag>
  );
}

export function Divider() {
  return <hr className={styles.divider} />;
}
