# Third-party provenance manifest

Every external component the AI Musician will depend on, with its exact pinned
revision and licence.

**Nothing listed here is vendored, submoduled or installed yet.** This phase
records provenance so the Musician phase starts from pinned, licence-checked
inputs rather than from whatever `main` happens to be that day.

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
| Role | Global score-to-score melody transformation and variation → **Musician — Developed** |
| Integration | **Not decided.** Isolated service, not a package dependency. |
| Model artifact | Pretrained weights published by upstream (Hugging Face). Not downloaded. |
| Checksum | *to record on first download* |

**Caveats**

- ABC notation in, ABC notation out. A conversion layer is required in both
  directions; music21 is the intended tool.
- The official environment is old and pinned to dated Python/PyTorch versions.
  It **must not** share a runtime with the application or with MIDI-RWKV.
- Verify the licence of the published *weights* separately from the repository
  licence. MIT on the code does not automatically cover the checkpoint.

---

## MIDI-RWKV

| | |
|---|---|
| Upstream | `christianazinn/MIDI-RWKV` |
| Pinned commit | `7c94e9e2980d1f3cdb0d3a9ca2780ef0a5af6530` |
| Default branch | `main` |
| Licence | MIT |
| Role | Selective symbolic infilling / local repair using surrounding context → **Musician — Refined** |
| Integration | **Not decided.** Submodule or isolated service. |
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

4. `MIDIMetrics` has **no detected licence**. It must not be vendored or
   redistributed until that is resolved with its author. If it is only needed
   for evaluation, prefer not to depend on it at all.

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

**Caveat**

MIDI-RWKV does **not** use this upstream — it pins its own fork
(`christianazinn/rwkv.cpp`, listed above). Decide deliberately which one is the
dependency. Using upstream may require porting whatever the fork changed;
using the fork means depending on a personal fork's maintenance.

---

## music21

| | |
|---|---|
| Upstream | `cuthbertLab/music21` |
| Pinned commit | `54bd4fecfe5fe7adb9b870d4647faf6ffbcf9618` |
| Default branch | `master` |
| Licence | BSD-3-Clause |
| Role | Deterministic symbolic normalisation, measures, meter/key/interval analysis, ABC ↔ MIDI conversion in the Musician orchestration layer |
| Integration | **Package dependency** (PyPI), inside the Musician service only |
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

1. **Pin exact SHAs.** No tags, no branches, no "latest".
2. **Record the checksum of every downloaded model artifact** at the moment it
   is first fetched, and verify it on every subsequent fetch.
3. **Resolve every UNKNOWN licence before the component is used**, not before it
   is shipped. An unlicensed dependency in a prototype is still an unlicensed
   dependency.
4. **No training datasets** are downloaded in this phase, or added to this file
   without a licence review.
5. Model weights are **never committed to this repository.** They are fetched by
   a documented script and verified against the checksum recorded here.
