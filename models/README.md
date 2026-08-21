# models/

Model weights live here at runtime. **They are never committed** — see rule 5 in
[`../third_party/MANIFEST.md`](../third_party/MANIFEST.md).

```bash
scripts/models/bootstrap.sh        # Linux, macOS, Git Bash
pwsh scripts/models/bootstrap.ps1  # Windows
```

[`manifest.json`](manifest.json) records, for every artifact: logical name,
upstream, exact revision, filename, expected size, sha256, licence and runtime
adapter version. Every sha256 in it was computed from the real download, not
copied from an upstream README.

The bootstrap downloads only what is missing, resumes partial transfers, and
**fails loudly on a checksum mismatch**. That last point is deliberate: a wrong
checkpoint that loads is worse than one that does not, because it produces
plausible output from the wrong model.

Total: about **1.43 GB**.

| Artifact | Size | Licence |
|---|---|---|
| `melodyt5/weights.pth` | 1,357,746,623 B | MIT (verified on the model card, independently of the code licence) |
| `midi_rwkv.pth` | 70,224,852 B | MIT (committed inside the MIT-licensed repo at the pinned revision) |

Normal CI never downloads any of this. Both models sit behind adapters with
deterministic fakes; the real-model suite is opt-in via `MUSICIAN_REAL_MODELS=1`.
