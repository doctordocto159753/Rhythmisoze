# ADR: runtimes for the AI Musician workers

**Status:** accepted for the container topology; **the MelodyT5 runtime decision
is deliberately left open** pending the compatibility spike.
**Date:** 2026-08-21

---

## Context

Two models, two incompatible published environments.

| | MelodyT5 | MIDI-RWKV |
|---|---|---|
| Upstream stack | old Python / PyTorch line | Python 3.11 + rwkv.cpp |
| Interface | ABC in, ABC out | token sequence infill |
| Weight | 1,357,746,623 B | 70,224,852 B |

The product needs **one** Musician API. The temptation is to read that as one
container, resolve both dependency trees against each other, and pin whatever
combination happens to import. The brief names this a dependency graveyard, and
it is right: the resulting environment is one nobody can reproduce, upgrade, or
reason about, and the first upstream change breaks it in a way that looks like a
model bug.

---

## Decision 1 — one API, three containers

**Accepted.**

```text
                 musician-api          ← the only public surface
                  (Python 3.12)
                       │
            ┌──────────┴──────────┐
     melodyt5-worker         rwkv-worker
      (Python 3.10)          (Python 3.11)
```

The workers publish no ports. They are reachable on the compose network and
nowhere else, because they load gigabytes of weights, have no authentication,
and their request shape is an implementation detail that would become a
compatibility obligation the moment anything outside could call it.

What crosses the wire between them is the **canonical contract** — never
model-native formats. The orchestrator does not know MelodyT5 speaks ABC. That
ignorance is the point: it makes modernising or replacing a worker a change
confined to one directory.

**Cost, stated:** three images to build, three to keep current, and a network
hop per model call. Accepted, because the alternative is a single environment
that cannot be reproduced.

---

## Decision 2 — CPU is the baseline, GPU is optional

**Accepted.**

`MUSICIAN_DEVICE=auto|cpu|cuda`. `auto` prefers a GPU when one exists and falls
back to CPU when it does not. **It never fails because CUDA is absent** — a
service configured for `auto` that refuses to start on a CPU VPS has
misunderstood the word.

`cuda` explicitly requested on a machine without a GPU logs a warning and uses
CPU rather than crashing. Refusing would be defensible; it would also mean a
driver problem takes the feature offline instead of making it slower.

The default torch index in the MelodyT5 image is the CPU wheel index. The GPU
compose override swaps it. A CPU host must never pull a CUDA build it cannot use.

---

## Decision 3 — upstream `rwkv.cpp`, not the fork

**Accepted.**

MIDI-RWKV pins `christianazinn/rwkv.cpp`. We take `RWKV/rwkv.cpp` at
`14663c83b6aba4885a47c1fba91204efc74a49d3`.

A personal fork's maintenance is not a dependency worth accepting for an
inference runtime. **The cost is real and must not be discovered late:** whatever
the fork changed may need porting. That is a spike task with a definite answer —
build upstream, run the reference fixtures, diff — and it belongs before the
worker is considered done. If upstream proves genuinely incompatible, the fork is
the fallback, pinned at the SHA in the manifest, and the reason gets recorded
here.

---

## Decision 4 — MIDIMetrics is excluded

**Accepted.**

It has **no detected licence** and is an *evaluation* dependency. The pipeline
does not need it: the Identity Guard is our own deterministic code, precisely so
that acceptance is not delegated to an outside metric.

Vendoring it to satisfy a recursive submodule init would put unlicensed code in
the tree. `scripts/vendor/bootstrap.sh` therefore initialises submodules
selectively and **announces** the skip rather than quietly omitting it.

---

## MIDI-RWKV: what the real checkpoint showed

Loaded and inspected directly (`torch.load`, `weights_only=True`), sha256
verified against `models/manifest.json`:

| | |
|---|---|
| Tensors | 402 |
| Architecture | RWKV — `emb`, `blocks.0..11.{ln1,ln2,att,ffn}`, `ln_out`, `head` |
| Layers | 12 |
| `emb.weight` | **(16000, 384)** |
| Parameters | 35.09 M |
| dtype | bfloat16 |
| Load time | 0.04 s (CPU) |

That embedding shape settled a question the code had got wrong twice.

**The tokenizer has two vocabularies, and the model embeds the second.** MMM's
base vocabulary is 663 tokens; `tokenizer_with_acs.json` then carries a **BPE
model of exactly 16000** — matching `emb.weight` row for row. Upstream's
`_tokenize_score` inserts the infill markers as *base* ids and then calls
`encode_token_ids` to convert the whole sequence.

The first implementation invented a token language entirely. The second used the
right tokens but stopped at base ids. **Neither would have raised.** A base id is
a valid index into a 16000-row embedding, so the model would have returned
fluent nonsense, and the only symptom would have been output quality — the
hardest kind of bug to attribute.

The worker now converts explicitly through `to_model_ids` / `from_model_ids`,
and cross-checks the tokenizer's BPE size against the checkpoint's embedding
rows at load time. A mismatch is a hard error, because the alternative is
plausible output from a vocabulary the model never learned.

The stop token is converted too: comparing generated ids against the *base*
`FillBar_End` would mean the stop is never recognised and every generation runs
to the token budget.

### Still to verify

Loading the checkpoint is not running it. An actual context-conditioned infill
(AC-M05) needs either rwkv.cpp built and the GGML conversion run, or the `rwkv`
pip runtime installed. That has not been done, and no claim is made about it.

---

## Open — can MelodyT5's inference adapter be modernised?

**Not decided. Not guessable. Must be measured.**

Two options:

1. **Modernise the adapter.** Keep the architecture and weights exactly; run the
   inference code on a maintained Python/PyTorch. Cheaper to operate, easier to
   patch, and one less stale image.
2. **Pin the legacy runtime** inside the worker container. Certain to reproduce
   upstream's behaviour; a container nobody can safely update.

### How it gets decided

`scripts/spike/melodyt5_compat.py` (to be written when weights are first
fetched):

1. generate **fixed-seed reference fixtures** with the official inference code on
   the official environment;
2. run the same fixtures on the modern runtime;
3. compare — not byte-identical output, which floating-point drift makes an
   unreasonable bar, but **semantic equivalence**: the notation parses, the note
   count is in range, the pitch distribution matches, and the round trip through
   our contract succeeds.

If every reference fixture passes: option 1, and the worker's base image moves to
a current Python. If any fails: option 2, and this ADR records exactly which
fixture failed and how.

**Until that spike has run against real weights, `melodyt5-worker` is built on
Python 3.10 as the conservative choice, and this document makes no claim about
which runtime is correct.** The conservative default is not a decision; it is the
absence of one, and it is labelled as such so nobody later reads it as settled.

---

## What has and has not been verified

| Claim | Status |
|---|---|
| API starts in CPU mode with no GPU | **verified** — tested |
| Both variants generate end to end | **verified** — 104 tests, fake adapters |
| Identity Guard rejects unrelated candidates | **verified** — tested |
| RWKV infill touches only its span | **verified** structurally; real-model case is opt-in |
| Worker stacks are isolated and containerised | **verified** — compose config validates; images not yet built |
| MelodyT5 real weights load and generate | **NOT verified** — needs the 1.36 GB download |
| MIDI-RWKV real weights load and infill | **NOT verified** — needs a built rwkv.cpp |
| CPU/GPU inference benchmarks | **NOT measured** |

The unverified rows are unverified because the weights have not been downloaded
and the images have not been built in this phase, not because they are expected
to fail. `tests/test_real_models.py` covers all of them and is opt-in via
`MUSICIAN_REAL_MODELS=1`.
