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


---

## Measured on the target machine

Windows 11, Intel i7, 32 GB RAM, NVIDIA RTX 4060 (8 GB). **CPU**, which is the
supported baseline:

| | Cold load | Peak RSS | Warm generation |
|---|---|---|---|
| MelodyT5 | 3.14 s | 1940 MB | 0.68 s at a 4-bar budget, 2.75 s at 19 bars |
| MIDI-RWKV | 3.00 s | 711 MB | 4.41 s mean per infill |

End-to-end, warm, through the two workers:

| Variant | Latency |
|---|---|
| Refined | 1.9 s |
| Developed | 8.3 s |
| Expanded | 14.5 s |

Both models fit comfortably in 32 GB with room to spare — combined peak is under
2.7 GB. A 4 vCPU / 8 GB server runs this; 16 GB gives headroom for the web app
and Postgres alongside.

### On the GPU

Measured on the same machine with `torch 2.5.1+cu121` against the RTX 4060
Laptop GPU (8188 MB, compute capability 8.9), via `SPIKE_DEVICE=cuda
scripts/spike/benchmark_real.py`:

| | Cold load | Peak RSS | Peak VRAM | Warm generation |
|---|---|---|---|---|
| MelodyT5 | 8.67 s | 983 MB | **1727 MB** | 1.20 s at a 4-bar budget, 1.91 s at 19 bars |
| MIDI-RWKV | 5.52 s | 892 MB | 81 MB | 6.08 s mean per infill |

**The two models want different devices, and the measurement is what says so.**

MelodyT5 gains where it matters: the expanded-length generation drops from
2.75 s to 1.91 s, and host memory halves because the weights move to the card.
The cold load is *slower* — 8.67 s against 3.14 s — which is the one-off cost of
initialising the CUDA context and copying 113 M parameters across, paid once per
process rather than once per request.

MIDI-RWKV is **slower on the GPU**: 6.08 s per infill against 4.41 s on the CPU,
using 81 MB of VRAM. That is not a surprise once the shape of the work is clear.
RWKV generates one token at a time through a recurrent state, so a 35 M-parameter
step is far too small to fill the card and the run is dominated by per-launch
overhead — of which there is one per token. The CPU has no such overhead.

Both devices produced the same fill for the same seed (`[65, 67, 69, 70, 69]`),
so this is a latency finding and not a numerical one.

**Recommended: MelodyT5 on the GPU, MIDI-RWKV on the CPU.** The workers are
already separate containers with their own `MUSICIAN_DEVICE`, so the hybrid
needs configuration rather than code — which is the case `compose.gpu.yaml`
exists for.

A GPU bug was found by taking the measurement rather than by reasoning about it:
`_sample_logits` called `numpy.asarray` on what CUDA hands back, which is a
device tensor and cannot be read without an explicit copy to host. Every infill
failed. The CPU path had never exercised it.

**Provenance of these numbers.** They come from a local CUDA build of torch
installed for the measurement, which is not part of the repository and not
recreated by `scripts/models/bootstrap`. The CPU figures above are the supported
baseline; these are evidence for the device recommendation, not a second
supported configuration.
