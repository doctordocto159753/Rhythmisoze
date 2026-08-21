# Third-party provenance manifest

Every external component the AI Musician will depend on, with its exact pinned
revision and licence.

**Amended 2026-08-21.** Integration is no longer undecided. Each entry below now
records how the component is actually consumed, following the three product
decisions in
[`../docs/architecture/musician-foundation.md`](../docs/architecture/musician-foundation.md).

The one thing that has not changed: **no model weight is committed to this
repository.** Weights are described in `models/manifest.json`, fetched by
`scripts/models/bootstrap.{sh,ps1}`, and verified by sha256 on every fetch.

SHAs were resolved from the GitHub API on **2026-08-21** and are the upstream
default-branch heads as of that date. Pin these, verify them, and do not
re-resolve silently.

Existing dependency provenance lives in
[`../docs/licenses/dependencies.md`](../docs/licenses/dependencies.md) and
[`../docs/licenses/instruments.md`](../docs/licenses/instruments.md). This file
covers only the Musician foundation.

---

## MelodyT5

| | |
|---|---|
| Upstream | `sanderwood/melodyt5` |
| Pinned commit | `9fc0e7dd02ba10a77b46f9d4a669451f17885fbc` |
| Default branch | `main` |
| Licence | MIT |
| Role | Global score-to-score variation. Runs in **both** Refined and Developed — see below. |
| Integration | **Decided.** Pinned submodule at `vendor/melodyt5/`, executed inside the isolated `melodyt5-worker` container. Never a package dependency of the app. |
| Model artifact | Pretrained weights published by upstream (Hugging Face). Not downloaded. |
| Checksum | *to record on first download* |

**Caveats**

- ABC notation in, ABC notation out. A conversion layer is required in both
  directions; music21 is the tool.
- The official environment is old and pinned to dated Python/PyTorch versions.
  It **must not** share a runtime with the application or with MIDI-RWKV. Whether
  the *inference adapter* can be modernised while keeping the architecture and
  weights is settled by the compatibility spike, not by assumption, and the
  outcome is recorded in `../docs/architecture/musician-runtime-adr.md`.
- Verify the licence of the published *weights* separately from the repository
  licence. MIT on the code does not automatically cover the checkpoint.
- The published weight is **~1.36 GB**. Not committed, and not baked into the
  image unless benchmarking shows immutable bundling is operationally better.

**Correction to the earlier version of this file.** MelodyT5 was previously
listed as producing the Developed version and MIDI-RWKV the Refined one. That
mapped each model to a product, when in fact each model does a different *job* -
global variation versus local infill - and **both run for both outputs**. Refined
and Developed are separated by policy (sampling freedom, motif tolerance, infill
budget, identity floor), not by which model was used.

---

## MIDI-RWKV

| | |
|---|---|
| Upstream | `christianazinn/MIDI-RWKV` |
| Pinned commit | `7c94e9e2980d1f3cdb0d3a9ca2780ef0a5af6530` |
| Default branch | `main` |
| Licence | MIT |
| Role | Selective symbolic infilling of nominated spans, conditioned on material either side. Runs in **both** Refined and Developed. |
| Integration | **Decided.** Pinned submodule at `vendor/midi-rwkv/`, executed inside the isolated `rwkv-worker` container. CPU inference is the baseline. |
| Model artifact | `midi_rwkv.pth`, 70,224,852 bytes, committed at the repository root |
| Checksum | *to record on first download* |

**Caveats — read before cloning**

This repository is the one most likely to be integrated incorrectly.

1. **Three nested submodules**, and they point at **forks**, not upstream:

   | Path | URL in `.gitmodules` | Pinned commit | Licence |
   |---|---|---|---|
   | `rwkv.cpp` | `christianazinn/rwkv.cpp` | `9122097b5a0efbae590901bb25566866b5d0424e` | MIT |
   | `MIDIMetrics` | `christianazinn/MIDIMetrics` | `f05e06a367de132d5e8ad612d54918b43f2dce19` | **UNKNOWN — must be resolved before use** |
   | `RWKV-PEFT` | `christianazinn/RWKV-PEFT` | `caa1c02a89d58158a9c82a7babc8e33a07f8196c` | Apache-2.0 |

2. **The submodule URLs are SSH** (`git@github.com:...`). An anonymous or CI
   clone fails unless they are rewritten:
   ```
   git clone --recurse-submodules \
     -c url."https://github.com/".insteadOf="git@github.com:" \
     https://github.com/christianazinn/MIDI-RWKV
   ```

3. **Do not copy individual files.** Cherry-picking sources from this tree
   produces something that appears to work and is not the model. Take the whole
   repository at the pinned commit, with submodules, or take a service boundary
   instead.

4. `MIDIMetrics` has **no detected licence**, and it is an **evaluation**
   dependency, not an inference one.

   **Operative rule: it is excluded from anything this project builds, ships or
   redistributes.** Rule 3 below forbids using an unlicensed component, and
   nothing in the Musician pipeline needs it - the Identity Guard is our own
   deterministic code, precisely so that acceptance is not delegated to an
   outside metric.

   If a recursive clone brings it in, it stays out of the image. If that proves
   impossible to arrange cleanly, vendor only the inference-facing subset of
   MIDI-RWKV, preserve the upstream licence and exact commit, and record the
   deviation. **Resolving its licence with its author is the only route to
   depending on it.**

---

## rwkv.cpp

| | |
|---|---|
| Upstream | `RWKV/rwkv.cpp` |
| Pinned commit | `14663c83b6aba4885a47c1fba91204efc74a49d3` |
| Default branch | `master` |
| Licence | MIT |
| Role | Inference runtime for the RWKV model family |
| Integration | **Not decided.** |
| Model artifact | None of its own; consumes converted RWKV checkpoints. |
| Checksum | n/a |

| Integration | **Decided.** Built from source inside `rwkv-worker`. CPU build is the baseline; GPU is an optional build flag. |

**Decision: upstream, not the fork.**

MIDI-RWKV pins its own fork (`christianazinn/rwkv.cpp`). We take
`RWKV/rwkv.cpp` instead. A personal fork's maintenance is not a dependency worth
accepting for an inference runtime, and upstream is the maintained line.

**The cost is real and must not be discovered late:** whatever the fork changed
may need porting. That is a spike task with a definite answer - build upstream,
run the reference fixtures, diff - and it belongs before the worker is
considered done, not after. If upstream turns out to be genuinely incompatible,
the fork is the fallback, pinned at the SHA above, and the reason is recorded
here.

---

## music21

| | |
|---|---|
| Upstream | `cuthbertLab/music21` |
| Pinned commit | `54bd4fecfe5fe7adb9b870d4647faf6ffbcf9618` |
| Default branch | `master` |
| Licence | BSD-3-Clause |
| Role | Deterministic symbolic normalisation, measures, meter/key/interval analysis, ABC ↔ MIDI conversion in the Musician orchestration layer |
| Integration | **Decided.** PyPI dependency of the `musician-api` orchestrator container only. Not in either model worker, and never in the web app. |
| Model artifact | n/a |
| Checksum | n/a |

**Caveats**

- **It must not silently rewrite music.** Several music21 operations normalise
  or re-spell content as a side effect of parsing or export. Any call that can
  alter note content belongs behind an explicit, logged transformation — never
  inside a conversion helper.
- It was evaluated and **declined** for the Music Teacher
  (see [`../docs/music-teacher.md`](../docs/music-teacher.md)): key detection is
  already covered by the humtool parity port and Tonal.js, and adopting music21
  there would have required the Python service for no gain. Its role here is
  different — conversion and measure handling — and does not reopen that
  decision.
- BSD-3-Clause requires the copyright notice and disclaimer to be reproduced in
  distributions.

---

## Rules for this file

1. **Pin exact SHAs.** No tags, no branches, no "latest". Upstream code is
   consumed as a submodule under `vendor/`, pinned to the SHA recorded here.
2. **Record the checksum of every model artifact** at the moment it is first
   fetched, and verify it on every subsequent fetch. The operational copy of
   that data is `models/manifest.json`; this file is the provenance record and
   the two must agree.
3. **Resolve every UNKNOWN licence before the component is used**, not before it
   is shipped. An unlicensed dependency in a prototype is still an unlicensed
   dependency. `MIDIMetrics` is currently the only one, and is excluded on
   exactly this ground.
4. **No training datasets.** Not downloaded, and not added to this file without
   a licence review.
5. **Model weights are never committed to this repository**, and never fetched
   by normal CI. They are downloaded by `scripts/models/bootstrap.{sh,ps1}` and
   verified against the checksum recorded here. CI exercises the pipeline
   through deterministic fake adapters; the real-model suite is opt-in via
   `MUSICIAN_REAL_MODELS=1`.
6. **Licence text travels with anything redistributed.** MIT requires the notice
   and permission text; BSD-3-Clause additionally requires the disclaimer. If a
   container image ships upstream code, the image ships its licences.
7. **If vendoring deviates from "whole repository at the pinned SHA"**, say so
   here and say why. A partial vendor that is not documented is indistinguishable
   from a copy-paste.
