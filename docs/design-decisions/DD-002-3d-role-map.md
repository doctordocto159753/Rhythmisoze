# DD-002 — 3D role map

**Status:** Accepted
**Date:** 2026-08-19
**Related:** D-0701, D-0702, D-0703, D-0704, D-0705, questionnaire Q-E3

---

## Scope

Q-E3 asks for all three roles to be prototyped and expresses no preference. All
three were considered (see DD-001); this record fixes where 3D is permitted and
what it must fall back to.

## The one place 3D appears

| Element | Where | State it carries | Fallback |
|---|---|---|---|
| **The resonating body** | Behind the record control, during `armed`, `countdown` and `recording` | The voice arriving, and the take settling | A static SVG of concentric rings using the same bounded level mapping |

That is the whole map. It does not appear on the workspace, the review screen,
the export panel, the share page or the design catalog. The playbook's rule —
3D only where it communicates musical state — is applied strictly enough that
there is exactly one instance of it in the product.

## Mappings

D-0702 requires every 3D property to declare what drives it, its range, its
smoothing and its fallback. All four, for all four properties:

| Property | Driven by | Range | Smoothing | Reduced / off |
|---|---|---|---|---|
| Radial swell | Input RMS | 1.00 – 1.22 | lerp 0.12 | Ring radius, same bounds |
| Vertical bias | Detected register | −0.25 – +0.25 | lerp 0.06 | none |
| Surface calm | Settling progress | rotation 0.28 → 0.06 rad/s | lerp 0.05 | none |
| Ring phase | Metronome beat index | one pulse per beat, decaying over exactly one beat | none — locked to the audio clock | the DOM beat dots |

Every range is bounded, so a shout cannot make the object cover a control.
Every value is smoothed, so a transient cannot make it flicker. The ring's life
is one beat because its timing comes from musical time, not from a number chosen
to look good.

## Performance ladder (D-0705)

| Tier | When | What renders |
|---|---|---|
| `full` | WebGL2, more than 4 GB and more than 4 cores, fine pointer, motion allowed | Object at detail 3, ring, DPR capped at 2, antialiasing |
| `reduced` | WebGL2 but a low-memory, low-core or touch device | Object at detail 1, flat shading, no ring, DPR 1 |
| `minimal` | `prefers-reduced-motion`, or no WebGL2 | The scene never mounts; the static SVG is the whole visual |

Detection is deliberately conservative: a phone reporting 4 GB gets `reduced`,
not `full`, because the number a browser reports is a ceiling rather than what is
free while a model is resident. The user can raise it by hand; a stuttering
record screen cannot be undone.

Core interactions are identical at all three levels, and no level changes audio
processing. The scene uses a **demand** frame loop rather than a continuous one:
it renders only while a value is still settling, and stops when the picture has.

## Structural guarantees

Enforced in `ResonantBody.module.css` rather than trusted to the scene:

- the 3D layer is `pointer-events: none`, so it can never swallow a tap meant
  for the record button;
- it sits behind its content in the stacking order, always;
- it is clipped to its own area, so no mapping can push geometry over a control.

`three` and `@react-three/fiber` load through `next/dynamic` with `ssr: false`,
so they are absent from the initial bundle and are never fetched by a visitor
who does not record.

## Materials and lighting (D-0704)

One material palette: a single brass-toned standard material, roughness 0.42,
metalness 0.12. Lighting is one warm key from above-front, one cool fill, and a
low ambient — the same three-value relationship the DOM palette uses. No
environment map, no HDRI, no shadows, no post-processing. The design package
lists a demo HDRI as an anti-pattern, and the absence here is deliberate rather
than unfinished.
