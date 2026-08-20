'use client';

/**
 * D-0702 / D-0703 / D-0704 / D-0705 - the audio-reactive object.
 *
 * ## What it is and why it exists
 *
 * One object, in one place: behind the record control, during recording and
 * processing only. It is the *resonating body* of the instrument - a form that
 * swells with the voice going into it and settles as the take is transformed.
 * It is not a visualiser, it does not appear on the workspace or the export
 * screen, and it never renders while the user is reading anything.
 *
 * ## The mapping (D-0702 requires each of these to be declared)
 *
 * | property     | driven by            | range              | smoothing     |
 * |--------------|----------------------|--------------------|---------------|
 * | radial swell | input RMS            | 1.00 - 1.22        | 0.12 lerp     |
 * | vertical bias| detected register    | -0.25 - +0.25      | 0.06 lerp     |
 * | surface calm | retouch/settling     | noise 1.0 - 0.15   | 0.05 lerp     |
 * | ring phase   | metronome beat index | one pulse per beat | none (locked) |
 *
 * Every one of them is bounded, so a shout cannot make the object cover a
 * control, and every one is smoothed, so a transient cannot make it flicker.
 *
 * ## Degradation (D-0705)
 *
 * `full`    - the object plus its ring, DPR capped at 2.
 * `reduced` - lower geometry detail, DPR capped at 1, no ring.
 * `minimal` - this component never mounts; the DOM state indicators are the
 *             whole interface, and nothing about the product is missing.
 *
 * The scene also stops rendering entirely when nothing is changing: the frame
 * loop is demand-driven rather than continuous, which is what keeps it from
 * competing with audio scheduling on a phone.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { Mesh } from 'three';
import { Color, MathUtils } from 'three';
import type { PerformanceTier } from '@audio-core';

export interface SceneProps {
  tier: Exclude<PerformanceTier, 'minimal'>;
  /** Input level 0..1. */
  level: number;
  /** Register 0..1, low to high. */
  register: number;
  /** 0 while raw, 1 once settled. */
  settled: number;
  /** Increments once per beat; drives the ring. */
  beatIndex: number;
  /** Seconds per beat, so the ring's decay is musical rather than arbitrary. */
  beatSeconds: number;
}

export default function Scene(props: SceneProps) {
  const detail = props.tier === 'full' ? 3 : 1;

  return (
    <Canvas
      // A demand frameloop: React Three Fiber only renders when something
      // invalidates. `Body` invalidates while values are still settling and
      // stops when they have, so a still object costs nothing.
      frameloop="demand"
      dpr={props.tier === 'full' ? [1, 2] : 1}
      gl={{ antialias: props.tier === 'full', alpha: true, powerPreference: 'low-power' }}
      camera={{ position: [0, 0, 3.4], fov: 42 }}
      style={{ position: 'absolute', inset: 0 }}
    >
      {/* Lighting matches the DOM system: one warm key from above-front, one
          cool fill, no environment map. A demo HDRI is explicitly ruled out. */}
      <ambientLight intensity={0.55} color={new Color('#f3eee5')} />
      <directionalLight position={[2, 3, 4]} intensity={1.1} color={new Color('#e8bc6a')} />
      <directionalLight position={[-3, -1, 2]} intensity={0.35} color={new Color('#4a5f9e')} />
      <Body {...props} detail={detail} />
    </Canvas>
  );
}

function Body({
  level,
  register,
  settled,
  beatIndex,
  beatSeconds,
  detail,
  tier,
}: SceneProps & { detail: number }) {
  const mesh = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const { invalidate } = useThree();

  const smoothed = useRef({ swell: 1, bias: 0, calm: 0, ringAge: Number.POSITIVE_INFINITY });
  const lastBeat = useRef(beatIndex);

  // Geometry and material are created once and reused. Re-creating either on a
  // prop change is the usual cause of a stutter in an otherwise cheap scene.
  const material = useMemo(
    () => ({
      color: new Color('#c98a1b'),
      roughness: 0.42,
      metalness: 0.12,
    }),
    [],
  );

  useFrame((_, delta) => {
    const body = mesh.current;
    if (!body) return;

    const target = {
      swell: 1 + MathUtils.clamp(level, 0, 1) * 0.22,
      bias: (MathUtils.clamp(register, 0, 1) - 0.5) * 0.5,
      calm: MathUtils.clamp(settled, 0, 1),
    };

    const previous = { ...smoothed.current };
    smoothed.current.swell = MathUtils.lerp(smoothed.current.swell, target.swell, 0.12);
    smoothed.current.bias = MathUtils.lerp(smoothed.current.bias, target.bias, 0.06);
    smoothed.current.calm = MathUtils.lerp(smoothed.current.calm, target.calm, 0.05);

    body.scale.setScalar(smoothed.current.swell);
    body.position.y = smoothed.current.bias;
    // As the take settles, the object turns more slowly and squarely - order
    // arriving, rather than a spin for its own sake.
    body.rotation.y += delta * (0.28 - smoothed.current.calm * 0.22);

    if (ring.current) {
      if (beatIndex !== lastBeat.current) {
        lastBeat.current = beatIndex;
        smoothed.current.ringAge = 0;
      }
      smoothed.current.ringAge += delta;
      // The ring's life is exactly one beat: its decay is musical time, not a
      // number chosen to look nice.
      const age = MathUtils.clamp(smoothed.current.ringAge / Math.max(0.1, beatSeconds), 0, 1);
      ring.current.scale.setScalar(1.15 + age * 0.5);
      const ringMaterial = ring.current.material as { opacity: number; transparent: boolean };
      ringMaterial.transparent = true;
      ringMaterial.opacity = (1 - age) * 0.5;
    }

    // Keep rendering only while something is still moving.
    const moving =
      Math.abs(previous.swell - smoothed.current.swell) > 0.0005 ||
      Math.abs(previous.bias - smoothed.current.bias) > 0.0005 ||
      Math.abs(previous.calm - smoothed.current.calm) > 0.0005 ||
      smoothed.current.ringAge < beatSeconds;
    if (moving) invalidate();
  });

  return (
    <group>
      <mesh ref={mesh}>
        <icosahedronGeometry args={[1, detail]} />
        <meshStandardMaterial {...material} flatShading={detail <= 1} />
      </mesh>

      {tier === 'full' ? (
        <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.05, 0.008, 8, 96]} />
          <meshBasicMaterial color={new Color('#a8720f')} transparent opacity={0} />
        </mesh>
      ) : null}
    </group>
  );
}
