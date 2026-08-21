# Musician foundation

**Status:** frozen. Authoritative for the next phases.
**Date:** 2026-08-21

This document fixes the version pipeline, the responsibility boundaries between
its stages, and the model foundation the AI Musician will be built on. Nothing
in it is implemented yet beyond the first three stages.

---

## The pipeline

```text
                        USER INPUT
                            │
              Extraction / intent routing
                            │
                    UNPROCESSED VERSION
                            │
                      MUSICAL JUDGE
                            │
                      JUDGE VERSION
                            │
                      MUSIC TEACHER
                            │
                     TEACHER VERSION
                            │
                       AI MUSICIAN
                    ┌───────┴────────┐
          MUSICIAN — REFINED   MUSICIAN — DEVELOPED
```

Five versions, in one order. Each stage consumes only the stage above it.

| Stage | Status | Package |
|---|---|---|
| Unprocessed | shipped | `melody-extraction`, `audio-core` |
| Judge | shipped | `musical-judge` |
| Teacher | shipped | `music-teacher` |
| Musician — Refined | **not implemented** | — |
| Musician — Developed | **not implemented** | — |

---

## Responsibilities, and the lines between them

The value of this architecture is not the stages. It is that each line between
them is a line somebody could otherwise be tempted to cross.

### Unprocessed
Direct machine extraction, preserved untouched for comparison.

It is not a debug view. It is the reference point that makes every claim about
the other four checkable, and it is offered to the user as a legitimate choice.

### Judge — *did we understand the human?*
The most faithful playable reconstruction of the actual performance.

**May** correct transcription artefacts: harmonics reported as notes, octave
slips, one held note fragmented into three, durations that outlast their sound.

**Must not** improve musical taste. A wandering, out-of-tune hum transcribed
perfectly is a perfect Judge result.

This is the only stage with ground truth — the audio — so it is the only one
that can be benchmarked against onsets, pitches and offsets. That property is
worth protecting: the moment the Judge is allowed to make things *nicer*, its
score stops telling us whether the system understood the recording.

### Teacher — *what would a teacher suggest?*
Deterministic, conservative, explainable symbolic refinement.

**May** move a brief out-of-key note, pull near-miss timing onto the performer's
own grid, even out note lengths, align repeated figures, lengthen a clipped
phrase ending.

**Must not** add or remove notes. V1 changes pitch, timing, duration and
velocity of notes that already exist, and nothing else. With the note count
fixed, "is it still the same melody?" has a checkable answer.

Bounded by: ≤34% of notes edited, ≤2 semitones per move, identity ≥0.82 or the
whole revision is discarded. Every edit carries a reason.

### Musician — *where could this go?*
Generative symbolic music intelligence. **Not implemented.**

Receives **Teacher Version only** — symbolic data, never raw microphone audio in
V1. It may develop the material, but must preserve the identity of the original
musical idea.

Two outputs, and only two:

**A. Musician — Refined**
> What would a skilled musician do to make this same idea more musical?

- conservative
- motif identity strongly preserved
- same general length and form
- rhythm, phrase and interval choices may improve

**B. Musician — Developed**
> Where could this idea go one controlled step further?

- more freedom
- motif still recognisable
- small phrase development and selective rewriting allowed
- must not become an unrelated composition

---

## Product rules, frozen

### The metronome is a recording guide, never MIDI truth

It exists so a person can perform steadily. It says nothing about the music they
made. Tempo, meter and groove come from **performance analysis**
(`rhythm-extraction`), and a user who taps 120 and sings at 83 gets 83.

Already implemented and tested; recorded here so it cannot be reversed by
accident.

### The AI Musician never receives raw audio in V1

Its input is the Teacher's symbolic output. This keeps the generative layer
independent of transcription quality, and keeps the audio path unchanged when
the Musician is added.

### The product must remain useful when the Musician is unavailable

Unprocessed, Judge and Teacher stay fully functional with no network, no model
and no service. The Musician is an addition, never a dependency.

### The "everything runs locally" claim is retired

Previously the landing page and footer stated that nothing is uploaded until
publish. That is no longer an architectural constraint, because the Musician
will need server-side inference.

**This is a user-facing promise being withdrawn, not a detail.** It must be
handled deliberately:

- the claim must be removed from the UI in the same change that first sends
  audio or symbolic data off-device — not before, and not after;
- what *is* still true should be stated instead: the recording itself stays on
  the device, and only symbolic note data reaches the Musician;
- if any path ever uploads audio, it needs explicit consent at the point of use.

Until the Musician ships, the existing local-only copy remains accurate and
should stay.

---

## Model foundation

Recorded, **not implemented**. No model code and no weights are committed in
this phase. Provenance lives in [`third_party/MANIFEST.md`](../../third_party/MANIFEST.md).

### MelodyT5 — global transformation
`sanderwood/melodyt5`

ABC-based score-to-score model with an explicit variation task and pretrained
weights. Role: whole-melody transformation, which maps onto **Musician —
Developed**.

Constraint: the official environment is old and must be isolated. It cannot
share a runtime with the application.

### MIDI-RWKV — local repair and development
`christianazinn/MIDI-RWKV`

Selective symbolic infilling using surrounding context. Role: local, targeted
development that leaves the rest of the phrase intact, which maps onto
**Musician — Refined**.

Inference foundation: RWKV / `rwkv.cpp`.

Constraint: the repository contains nested submodules. Vendoring files
individually will produce something that appears to work and is not the model.

### music21 — deterministic symbolic utility
Orchestration-layer only: normalisation, measures, meter/key/interval analysis,
ABC ↔ MIDI conversion.

**It must not silently rewrite music.** Any music21 call that could alter note
content belongs behind an explicit, logged transformation, not inside a
conversion helper.

Note that music21 was already evaluated and declined for the Teacher
(see [`../music-teacher.md`](../music-teacher.md)) because key detection is
already covered by the tested humtool port and Tonal.js. Its role here is
different: conversion and measure handling for the Musician layer.

### Out of scope for this phase
Training datasets are not to be downloaded.

---

## What the Musician phase must not disturb

- **The humtool parity port.** `src/packages/retouch/port.ts` mirrors
  `reference/humtool.py`. CI regenerates the golden fixtures from Python and
  fails on any diff. Improvements belong in `extensions.ts`.
- **The instrument engine.** Sample packs, registry and offline render.
- **The three shipped versions.** Adding two more must not change what
  Unprocessed, Judge or Teacher produce.

---

## Open questions for Phase 2

1. **Where does inference run?** Self-hosted GPU, cloud worker, or on-device
   quantised. This decides latency, cost and the privacy copy.
2. **How is Musician identity measured?** The Teacher has bounded edit distance
   because it cannot add notes. The Musician can. A different identity measure
   is needed — motif retention and contour correlation are candidates, and
   neither is settled.
3. **What happens when the Musician is slow or down?** The other three versions
   must still appear immediately.
4. **Which of the two outputs is default?** Probably neither — Teacher stays the
   default and the Musician versions are opt-in.
