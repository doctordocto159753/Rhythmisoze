# models/

Model weights live here at runtime. **They are never committed** — see rule 5 in
[`../third_party/MANIFEST.md`](../third_party/MANIFEST.md).

```bash
scripts/models/bootstrap.sh        # Linux, macOS, Git Bash
pwsh scripts/models/bootstrap.ps1  # Windows

scripts/models/bootstrap.sh game   # plus the optional register witness
```

Artifacts marked `optional` are skipped unless named. "Optional" here does not
mean "less important" — it means **the licence on those weights is not this
project's licence**, so fetching them is a decision rather than a step. The
script prints the terms before it downloads one.

[`manifest.json`](manifest.json) records, for every artifact: logical name,
upstream, exact revision, filename, expected size, sha256, licence and runtime
adapter version. Every sha256 in it was computed from the real download, not
copied from an upstream README.

The bootstrap downloads only what is missing, resumes partial transfers, and
**fails loudly on a checksum mismatch**. That last point is deliberate: a wrong
checkpoint that loads is worse than one that does not, because it produces
plausible output from the wrong model.

Total: about **1.43 GB**, plus **47 MB** if you fetch the optional witness.

| Artifact | Size | Licence |
|---|---|---|
| `melodyt5/weights.pth` | 1,357,746,623 B | MIT (verified on the model card, independently of the code licence) |
| `midi_rwkv.pth` | 70,224,852 B | MIT (committed inside the MIT-licensed repo at the pinned revision) |
| `game/` (optional) | 46,886,125 B zipped | **CC BY-NC-SA 4.0** — non-commercial, share-alike. GAME's *code* is MIT; its *weights* are not. Rhythmisoze is MIT, so these are not redistributable with it, and a deployment that uses them is a non-commercial one. |

The GAME entry is the reason the "verify the weights licence separately from the
code licence" rule exists in `../third_party/MANIFEST.md`. Two of the three
artifacts here pass that check; one does not, and it is optional because of it.

Normal CI never downloads any of this. Both models sit behind adapters with
deterministic fakes; the real-model suite is opt-in via `MUSICIAN_REAL_MODELS=1`.
