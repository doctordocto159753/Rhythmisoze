'use client';

/**
 * The DOM side of the audio-reactive object (D-0701, D-0705).
 *
 * Owns three things the WebGL scene must not:
 *  - the decision about whether 3D runs at all;
 *  - a designed static fallback, so `minimal` is a considered state rather
 *    than a hole where a canvas used to be;
 *  - the lazy import, so `three` and `@react-three/fiber` are never in the
 *    initial bundle and are never fetched by a user who does not record.
 *
 * The rule the design package sets is that 3D may only appear where it carries
 * meaning and must never obstruct a control. Both are enforced structurally
 * here: the layer is `pointer-events: none` and sits behind its content, and it
 * only mounts during recording and processing.
 */

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import type { PerformanceTier } from '@audio-core';
import { usePerformanceTier } from '@/features/shell/useCapabilities';
import styles from './ResonantBody.module.css';

const Scene = dynamic(() => import('./Scene'), {
  ssr: false,
  // No skeleton: the fallback is the static figure below, already on screen.
  loading: () => null,
});

export interface ResonantBodyProps {
  active: boolean;
  level: number;
  register: number;
  settled: number;
  /** Overrides the automatic tier. Wired to the visual-detail control. */
  tier?: PerformanceTier;
  children?: ReactNode;
}

export function ResonantBody({
  active,
  level,
  register,
  settled,
  tier,
  children,
}: ResonantBodyProps) {
  // The tier is read from the capability store, which returns a stable server
  // snapshot ('minimal') during SSR and the real value on the client. That
  // makes the first paint match the server HTML and avoids a mount effect.
  const detected = usePerformanceTier();
  const effective = tier ?? detected;

  return (
    <div className={styles.wrap}>
      <div className={styles.layer} aria-hidden="true">
        {active && effective !== 'minimal' ? (
          <Scene
            tier={effective}
            level={level}
            register={register}
            settled={settled}
          />
        ) : (
          <StaticBody active={active} level={level} />
        )}
      </div>
      <div className={styles.content}>{children}</div>
    </div>
  );
}

/**
 * The `minimal` tier, designed rather than absent.
 *
 * Concentric rings whose radius follows the same bounded level mapping the 3D
 * object uses. It carries the identical meaning - the voice arriving - in one
 * SVG and no frame loop.
 */
function StaticBody({ active, level }: { active: boolean; level: number }) {
  const swell = 1 + Math.max(0, Math.min(1, level)) * 0.18;
  return (
    <svg className={styles.static} viewBox="0 0 200 200" aria-hidden="true">
      <g
        transform={`translate(100 100) scale(${active ? swell : 1})`}
        fill="none"
        stroke="currentColor"
      >
        <circle r="52" strokeWidth="1.5" opacity={active ? 0.5 : 0.25} />
        <circle r="66" strokeWidth="1" opacity={active ? 0.3 : 0.14} />
        <circle r="80" strokeWidth="1" opacity={active ? 0.16 : 0.07} />
      </g>
    </svg>
  );
}
