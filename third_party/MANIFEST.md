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
covers the Musician foundation and the optional transcription engine.

---

## GAME (optional register witness)

| | |
|---|---|
| Upstream | `openvpi/GAME` |
| Pinned commit | `4ad815c90dfe2442730f3fdc866fd23e737cbc97` |
| Default branch | `main` |
| Licence (code) | MIT |
| Licence (**weights**) | **CC BY-NC-SA 4.0** |
| Role | A second opinion about which octave a note is in. Never a transcription in its own right. |
| Integration | Cloned at the pinned SHA inside the `transcription` container image and driven through its own `infer.py`. Never a package dependency of the app, and not a `vendor/` submodule — see rule 7 below. |
| Model artifact | `GAME-1.0-small.zip`, release `v1.0.0`, 46,886,125 bytes |
| Checksum (zip) | `3d3e1ac0a83234b2a163a3d43043455d15670765eaa25ef6285c399da1ccc576` |
| Checksum (`model.pt`) | `7dd10022a4011938843249a31d9527691376c493d13687a7fc1dec88786b9691` |

**The licence split is the important line in this table.** The repository is MIT
and can be built into an image. The v1.0.0 release notes state plainly: *"The
model files apply CC BY-NC-SA 4.0 license."* Non-commercial, attribution,
share-alike — which is not Rhythmisoze's MIT, and does not become it by being
downloaded into a container.

Consequences, all of them deliberate:

- the weights are never committed and never baked into the image (rule 5);
- `scripts/models/bootstrap.sh` skips this artifact unless it is named, and
  prints the licence before fetching it;
- **a deployment that enables this service is a non-commercial deployment**, and
  that is the operator's decision to make knowingly;
- the product is complete without it. A register correction requires two
  agreeing engines, so a deployment without this one reports disagreements
  instead of acting on them.

**Rejected: Dynamic HumTrans** (`shubham-gupta-30/humming_transcription`).
Evaluated because humming is a core use case. Not adopted, on two independent
grounds verified against the upstream repository: it states **no licence at
all**, and its checkpoints are not reproducibly obtainable — the README says the
authors are "having some trouble uploading our model checkpoints through GIT
LFS" and asks users to contact them for access. Rule 3 disposes of the first on
its own. Recorded here rather than worked around.

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
| Integration | **Decided.** Pinned checkout at `vendor/midi-rwkv/` (no submodules -- see caveat 2), executed inside the isolated `rwkv-worker` container. CPU inference is the baseline, via the Python `rwkv` package. |
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

2. **The submodule URLs are SSH** (`git@github.com:...`), so an anonymous or CI
   clone cannot initialise any of them.

   **We initialise none.** `scripts/vendor/bootstrap.{sh,ps1}` takes the
   repository at its pinned SHA and stops there. An earlier version rewrote the
   URLs to HTTPS and initialised `rwkv.cpp`; on Windows with no GitHub SSH key
   that still died with `Host key verification failed`, part-way through the
   loop, leaving the *upstream* `vendor/rwkv.cpp` fetched afterwards missing
   entirely. The supported path did not work on a supported platform.

   Nothing is lost by skipping them. What inference reads from this repository is
   one file -- `train/tokenizer/tokenizer_with_acs.json` -- and it is in the main
   tree. `rwkv.cpp` here is a personal fork of a repository we deliberately
   vendor from upstream (below), and rwkv.cpp is not on the V1 path at all.

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
| Integration | **Decided -- deferred.** Vendored at the pin above and mounted read-only into `rwkv-worker` at `/vendor`. **Not built, and not required for V1.** |
| Model artifact | None of its own; consumes converted RWKV checkpoints. |
| Checksum | n/a |

**Decision: not on the V1 path.**

The V1 MIDI-RWKV runtime is the Python `rwkv` package, verified against the real
checkpoint -- see `docs/architecture/musician-runtime-adr.md`. `inference.py`
prefers rwkv.cpp and reaches for it only when a converted GGML weight
(`midi_rwkv.bin`) exists; `scripts/models/bootstrap` produces none, so on every
supported V1 deployment the pip runtime is what runs.

The worker image therefore builds no C++. It used to try, with
`COPY vendor/rwkv.cpp /opt/rwkv.cpp` -- which could never succeed, because
compose builds that service with `context: ./services/musician` and `vendor/` is
at the repository root. Every `docker compose build` failed with
`"/vendor/rwkv.cpp": not found`. The step was mandatory, dead, and outside its
own context; `services/musician/tests/test_deployment.py` now fails if it
returns.

Enabling rwkv.cpp later needs the GGML conversion and the bindings, not a
rebuild: the vendored source is already mounted at runtime.

**Upstream, not the fork.**

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

   GAME deviates. It is not a `vendor/` submodule: it is cloned at the pinned
   SHA during the `transcription` image build and lives only inside that image.
   The reason is that it is optional, its runtime is a PyTorch stack no other
   part of this repository wants, and a submodule would put it in every clone in
   exchange for nothing. The pin is `GAME_REVISION`, a build argument, and it is
   the same SHA recorded above.

8. **A model's weights are licensed separately from its code, and the difference
   decides whether it can be a default.** Recording both is not paperwork: GAME
   is MIT code with CC BY-NC-SA weights, and that single fact is why its service
   is off unless an operator turns it on.
