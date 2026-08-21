# Musician — Expanded

**Status:** implemented and verified against the real models.
**Date:** 2026-08-21

The sixth version. Where Refined and Developed ask *"is this the same piece?"*,
Expanded asks *"is this grown from the same seed?"* — and those are not the same
measurement.

---

## What it is for

> I only had this small melodic idea. Show me what a musician might grow it into.

A four-bar hum becomes a passage with real structure — `A A' B A''` — in which
the original is still recognisable. Growth in duration is the **point**, not a
failure to stay close.

That distinction is not cosmetic. If Expanded were judged by the Refined rules
it would be rejected precisely when it succeeded.

---

## The three policies, side by side

| | Refined | Developed | Expanded |
|---|---|---|---|
| Sampling temperature | 0.70 | 0.95 | 1.15 |
| Candidates | 4 | 4 | 5 |
| Infill spans | ≤ 1 | ≤ 3 | ≤ 4 |
| Identity floor | 0.78 | 0.62 | **0.52** |
| **Motif floor** | 0.60 | 0.45 | **0.55** |
| Duration ceiling | 1.15× | 1.45× | **6.0×** |
| Duration *floor* enforced | yes | yes | **no** |
| Bar budget | 1.25× source | 1.6× | 6× (max 32) |

**Expanded's motif floor is higher than Developed's, deliberately.** A longer
passage has more room to drift, so the seed has to be *more* clearly present,
not less. The aggregate floor drops because duration and phrase similarity
legitimately fall; the motif requirement rises because it is the thing that
still has to hold.

---

## Reweighting, not loosening

The Identity Guard is the same deterministic code. What changes is what counts:

| Dimension | Default | Expanded | Why |
|---|---|---|---|
| motif | 0.26 | **0.38** | the single question that matters for growth |
| contour | 0.34 | 0.30 | still compared, by shape, via DTW |
| tonal | 0.14 | 0.18 | a grown passage should stay in its key |
| phrase | 0.16 | **0.04** | `A A' B A''` has more phrases by construction |
| meter | 0.10 | 0.10 | unchanged; a meter switch is still a rejection |

`allow_growth` turns off the duration *lower* bound and the density band, and
keeps the upper bound as a runaway stop. The numbers are still reported — they
are useful diagnostics — they simply stop being rejection criteria for a variant
whose purpose is to grow.

**This is not a second judge, and it is not a quality score.** It answers "is
this still the user's idea?" and nothing else.

---

## Bounded, not unlimited

Three independent limits, because each catches what the others cannot:

1. **Bar budget scaled from the source** — 6× its own bar count. A four-bar seed
   and a thirty-two-bar phrase do not want the same ceiling.
2. **Absolute cap of 32 bars.** A ratio alone cannot stop a one-bar seed
   becoming two hundred bars when a model loses the thread.
3. **Duration ceiling of 6×** in the guard, as a last check on the result rather
   than on the generation.

A four-bar source becoming nineteen useful bars is valid. Becoming an
uncontrolled four-minute unrelated tune is not, and each of the three limits
fails it independently.

---

## Two things real output taught us

### MelodyT5 writes tunes, not phrases

Given four bars it returns a complete sixteen-bar melody with repeats, because
that is its training distribution. Refined and Developed were rejecting **every**
candidate on the duration bound — 0 of 4 passing, both silently falling back to
Teacher.

Non-growth policies now **trim** the opening of what the model wrote to their
own ceiling rather than discarding it. Expanded is left untouched; trimming it
would defeat it.

### Ranking has to know which variant it is ranking

Survivors are ranked on musical structure, not on identity — maximising a
guardrail selects the candidate that changed least, which is the one that did
the least work.

But that reward is *smoothness improvement*, and the smoothest answer is usually
the short one. After a parser fix raised the number of surviving candidates, the
ranking promptly chose an 18-note result over a 61-note one for Expanded, which
quietly turns it into a second Developed.

Growth policies now add a growth term: `log2(ratio)`, capped at 3. Two times is
worth 1 and eight times only 3, so it prefers growth without becoming
"longest wins" — a runaway cannot outrank a musically better shorter passage.

---

## Verified, on the real models

One Teacher phrase, real MelodyT5 and real MIDI-RWKV, no fake adapters:

| | Notes | Span | Ratio | Identity | Motif | Infills |
|---|---|---|---|---|---|---|
| Teacher | 12 | 5.95 s | — | — | — | — |
| Refined | 13 | 6.5 s | 1.09× | 0.992 | 1.00 | 0 |
| Developed | 18 | 8.5 s | 1.43× | 0.930 | 1.00 | 0 |
| **Expanded** | **66** | **31.5 s** | **5.29×** | 0.922 | 1.00 | **2** |

Three distinct outputs; the length progression is the policy separation.

Rejection is tested as well as acceptance: a passage of the same length as a
successful expansion, valid in every mechanical sense and not derived from the
seed, is **rejected**. Length never earns acceptance.
