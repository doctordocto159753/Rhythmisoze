# Skill — Three.js Audio-Reactive Spatial Design

## Use when
Adding or revising Three.js, React Three Fiber, shaders, particles, materials, audio-reactive objects or spatial interaction.

## Goal
Use 3D as a semantic musical material, never as decorative proof that WebGL is available.

## Preferred architecture
- Three.js renderer through React Three Fiber when integrated with React UI.
- Drei helpers only where they reduce plumbing without dictating visual style.
- Audio features sourced from Web Audio analysis or stable derived musical state.
- Scene lazy-loaded after core interaction is usable.
- Performance mode: full / reduced / off.

## Required design mapping
Every 3D property must answer:
- What product/music state drives it?
- What perceptual meaning does it carry?
- What is its min/max range?
- How is it smoothed?
- What is the static/reduced fallback?

Possible mappings:
- amplitude → bounded deformation or scale;
- pitch/register → vertical bias/material parameter;
- tempo → phase/pulse;
- processing → controlled topology/material transition;
- raw-to-clean → order/noise/tension transition.

## Performance rules
- do not render continuously if the scene is static;
- cap DPR;
- reuse geometry/materials;
- avoid unnecessary re-mounts;
- use instancing/points for repeated objects;
- measure low-end mobile;
- degrade expensive shadows/transmission/post-processing first.

## Avoid
- floating blob by default;
- particle storms;
- demo HDRI;
- OrbitControls in final user experience unless interaction needs it;
- uncontrolled camera motion;
- 3D replacing accessible DOM controls.

## Definition of done
The feature communicates its state even when viewed for the first time, maintains core audio performance, and has an intentional non-3D fallback.
