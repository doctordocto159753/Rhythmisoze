# Musician foundation

**Status:** frozen. Authoritative for the next phases.
**Date:** 2026-08-21
**Amended:** 2026-08-21 - three product decisions taken. They supersede the
open questions and the one-model-per-output mapping this document originally
carried; both are marked below where they were changed.

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

Provenance lives in [`third_party/MANIFEST.md`](../../third_party/MANIFEST.md).
No weights are committed to this repository.

### Decision: both models run, in sequence, for both outputs

**This supersedes the earlier mapping** of one model to one output (MelodyT5 →
Developed, MIDI-RWKV → Refined). That mapping described what each model is good
at, and then mistakenly turned it into product structure.

The two models do different *jobs*, not different *products*:

| Model | Job | Scope |
|---|---|---|
| **MelodyT5** | global score-to-score variation | the whole melody at once |
| **MIDI-RWKV** | selective infill conditioned on both sides | one nominated span |
| **music21** | deterministic symbolic support | parse, validate, measures, meter, ABC ↔ score |

Both Refined and Developed run the same sequence:

```text
Teacher Version
      │
  normalise → canonical symbolic contract → music21 → ABC
      │
  MelodyT5 variation ──► a few candidates
      │
  Identity Guard ──► reject anything that left the idea behind
      │
  rank survivors
      │
  nominate weak span(s) ──► MIDI-RWKV infill ──► accept only if it improves
      │
  Identity Guard again
      │
  output
```

### What actually separates Refined from Developed

Not the models. Not the seed. **Policy** - and it must be visible in the code as
policy, or the two outputs are one output twice.

| | Refined | Developed |
|---|---|---|
| Sampling | conservative | moderately freer |
| Motif | strongly preserved | recognisable, may be developed or restated |
| Meter | normally preserved | preserved unless an explicitly classified transformation |
| Phrase count | normally preserved | may extend slightly if coherent |
| Duration | close to source | close, with more tolerance |
| Infill spans | at most one, only if it improves | a small number |
| Identity floor | higher | lower, still enforced |

If those two columns ever collapse into the same numbers, the feature has
stopped offering a choice.

### music21 must not make creative edits

Its role is parse, validate, recover measures, meter hierarchy, key and interval
context, and ABC conversion. Several music21 operations normalise or re-spell
content as a side effect of parsing or export. Any call that could alter note
content belongs behind an explicit, logged transformation, never inside a
conversion helper.

music21 was evaluated and declined for the Teacher
(see [`../music-teacher.md`](../music-teacher.md)), because key detection there
is already covered by the tested humtool port and Tonal.js. Its role here is
different - conversion and measure handling - and does not reopen that decision.

### Runtime isolation is a requirement, not a preference

MelodyT5's published setup is an old Python/PyTorch stack. MIDI-RWKV's published
experiments use Python 3.11 and rwkv.cpp. **They must not share an environment.**
Forcing them into one container to satisfy the word "microservice" produces a
dependency graveyard.

### Out of scope

Training datasets are not to be downloaded.

## What the Musician phase must not disturb

- **The humtool parity port.** `src/packages/retouch/port.ts` mirrors
  `reference/humtool.py`. CI regenerates the golden fixtures from Python and
  fails on any diff. Improvements belong in `extensions.ts`.
- **The instrument engine.** Sample packs, registry and offline render.
- **The three shipped versions.** Adding two more must not change what
  Unprocessed, Judge or Teacher produce.

---

## Decisions taken

These were open questions in the first version of this document. They are no
longer open, and the answers constrain the implementation.

### 1. Where inference runs — **self-hosted, CPU baseline**

A self-hosted service. **CPU mode is mandatory and is the production baseline.**
GPU acceleration is optional and must never be required: the service starts, and
generates, on a VPS with no CUDA at all. `MUSICIAN_DEVICE=auto|cpu|cuda`, and
`auto` degrades rather than crashes.

One product-facing API, several internal containers:

```text
                 musician-api          ← the only public surface
                  (orchestrator)
                       │
            ┌──────────┴──────────┐
     melodyt5-worker         rwkv-worker   ← never exposed publicly
```

Generation is **asynchronous** — `POST /v1/jobs` returns a job id immediately.
Workers stay warm and load weights once.

This also settles what happens when the Musician is slow or unavailable: it is
an optional layer behind a job queue, so Unprocessed, Judge and Teacher appear
immediately and are unaffected. That was already a frozen product rule; the
architecture now enforces it rather than promising it.

**Consequence for the privacy copy:** this is server-side inference, so the
retirement of the "everything runs locally" claim (above) is now on a schedule
rather than hypothetical. The claim comes out in the same change that first
sends data off-device, and what remains true — that the recording itself stays
on the device and only symbolic note data leaves it — is stated in its place.

### 2. How identity is measured — **a deterministic Identity Guard**

The Teacher has bounded edit distance only because it cannot add notes. The
Musician can, so a different measure is required, and it is deterministic —
never the generative model judging its own output.

Teacher and candidate are compared across: interval-contour similarity, motif
survival, phrase/order similarity, tonal compatibility, meter compatibility,
duration ratio, pitch-range change, and note-density change.

**DTW is used here, and this does not contradict the Judge.** The Judge forbids
time warping because its candidate was derived from the audio, so warping would
hide the very rhythm distortion it exists to catch. The Musician is *deliberately
allowed* to alter timing while keeping the tune, so a timing-independent
comparison is exactly the right instrument. Same technique, opposite reason.

The guard runs **after MelodyT5 and again after infill**, and it is a
**guardrail, not a quality score**. It answers "is this still the user's idea?"
and nothing else. It must never be shown to a user as a measure of how good the
music is.

### 3. Weights are never committed — **manifest plus bootstrap**

`models/manifest.json` records logical name, upstream, exact revision, filename,
expected size, sha256, licence and adapter version for every artifact.
`scripts/models/bootstrap.{sh,ps1}` downloads only what is missing, resumes where
possible, verifies sha256, and fails loudly on mismatch.

MelodyT5's published weight is ~1.36 GB. It is **not** baked into the image
unless benchmarking shows immutable bundling is operationally better.

**Normal CI never downloads weights.** Both models sit behind adapters with
deterministic fakes; the real-model suite is opt-in via
`MUSICIAN_REAL_MODELS=1`.

---

## Still open

- **Which output is the default.** Teacher remains the default and the two
  Musician versions are opt-in; whether Refined is ever promoted is a product
  question, not an architectural one, and is not settled here.
- **Whether the legacy MelodyT5 runtime can be modernised.** To be decided by
  the compatibility spike against fixed-seed reference fixtures, and recorded in
  [`musician-runtime-adr.md`](musician-runtime-adr.md) — not by assumption.
