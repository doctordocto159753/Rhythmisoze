# DD-001 — Visual thesis

**Status:** Accepted
**Date:** 2026-08-19
**Related:** D-0001, D-0002, D-0102, D-0103, D-0104, D-0105, questionnaire Q-E2, Q-D3

---

## The three territories that were considered

D-0001 asks for three materially different directions, not three colour
variations. All three were worked through before converging.

**A — Quiet material (chosen).** A warm paper ground, ink text, one brass accent.
The product behaves like a tuned wooden object on a workbench under warm light.
Motion is rare and musical. 3D is one small resonating body, present only while
the voice is actually going in.
*Why it wins:* the product's promise is that a rough sound becomes usable
material. A material metaphor states that directly, and it stays legible at the
one moment that matters — a person performing into a microphone, who cannot be
studying an interface.

**B — Kinetic / rhythmic.** Everything on a visible grid, elements snapping to
subdivisions, a strong pulse through the whole field.
*Why it loses:* it makes the interface itself feel metrical, which competes with
the metronome the user is trying to follow. The interaction-motion skill's
warning about easing that makes a beat land late applies to a whole layout here.

**C — Spatial / 3D-led.** A room the sketch exists inside; instruments as objects
in space; the piano roll as a receding plane.
*Why it loses:* it fails the mobile case first, costs the most on exactly the
devices the performance gate is about, and makes the record screen — the one
screen that must be instantly readable — the most complex thing in the product.

## The thesis

> Rhythmisoze should feel like a **tuned wooden object on a workbench under warm
> light**. Not a dashboard, not a DAW, not a neon visualiser.

Q-E2 selects a light creation environment; the palette is built for it, with a
restrained dark inversion for a viewer whose whole system is dark.
Q-D3 selects a minimal, direct tone; the copy says the thing, offers the next
action, and stops.

## The five invariants

These survive both locales, every breakpoint and every performance tier. They
are written into the top of `src/styles/tokens.css` so the reason sits next to
the rule.

1. **One ground.** A single warm paper field runs edge to edge. Panels are
   recessed (`Well`) or lifted (`Raised`) *within* it. Nothing floats on its own
   background — which is why there is no `Card` primitive, and why one cannot be
   added without superseding this record.
2. **One focal object.** Each stage has exactly one thing that is largest and
   warmest: the tap pad in setup, the record control during a take, the sketch
   during review. Everything else steps back.
3. **Time runs along one axis.** The pulse, the waveform, the piano roll, the
   cleanup continuum and the playhead all read left-to-right, in both locales.
   Text direction flips; time does not.
4. **Warmth means sound.** The brass accent appears only where audio is being
   made or heard. A button that does not touch audio never uses it — which is
   why "Publish" is accent and "Rename" is not.
5. **Stillness is the default.** Motion happens on musical events, never
   continuously. Nothing loops for decoration. The processing figure moves only
   as real progress arrives; if inference stalls, the picture stalls.

## Anti-directions

From the design package, restated so they can be cited in review: no SaaS card
grid, no DAW transport chrome, no purple-blue "AI product" gradient, no neon
cyberpunk visualiser, no excessive glassmorphism, no floating blob, no motion
competing with tempo, no primitive first-pass spacing presented as final.

## Typography

Two families, so neither script is a fallback (D-0101). **Vazirmatn** carries
Persian, **Inter** carries Latin; both OFL-1.1 and self-hosted, so the CSP stays
closed to third-party hosts. Persian gets a looser line box
(`--leading-persian`) and no negative tracking, because Persian letterforms are
already tightly fitted and negative tracking smudges the joins.

Numerals that are *measurements* — BPM, timers, note names — stay Latin with
tabular figures in both locales. They are identifiers a user compares against a
metronome app, a tuner or a DAW, and localising them makes matching harder.
Prose numbers in Persian use Persian-Indic digits (`localizeDigits`).

## How to tell whether a screen still obeys this

The design package's final question, applied literally: *does this feel like one
musical instrument whose behaviour has been composed, or like software
components placed around an audio feature?* If a screen has grown a second
lifted surface, a second accent-coloured control that touches no audio, or a
loop that runs when nothing is happening, it has drifted from this record.
