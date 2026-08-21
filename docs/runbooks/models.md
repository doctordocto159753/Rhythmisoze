# Model weights

**No weight is ever committed to this repository.** They are described in
[`models/manifest.json`](../../models/manifest.json) and fetched by a script
that verifies every byte.

```bash
scripts/models/bootstrap.sh        # Linux, macOS, Git Bash
pwsh scripts/models/bootstrap.ps1  # Windows
```

## What gets downloaded

| Artifact | Bytes | Licence |
|---|---|---|
| `melodyt5/weights.pth` | 1,357,746,623 | MIT — verified on the model card, independently of the code licence |
| `midi_rwkv.pth` | 70,224,852 | MIT — committed inside the MIT-licensed repo at the pinned revision |

Total about **1.43 GB**.

Every sha256 in the manifest was computed from the real download, not copied
from an upstream README.

## What the script guarantees

- downloads only what is missing;
- resumes a partial transfer rather than starting over;
- verifies sha256 **every time**, including for files already present;
- **fails loudly and non-zero on a mismatch.**

That last point is deliberate. A wrong checkpoint that loads is worse than one
that does not, because it produces plausible output from the wrong model.

All four paths are exercised against the real artifact: fresh download, present
and skipped, corrupted and refused, truncated and resumed.

## A note on history

`midi_rwkv.pth` was once committed to this repository by accident: a download
whose `cd` silently failed wrote it to the repository root, where the
directory-scoped ignore rules did not reach it. That is why this branch was
imported from the feature branches' *tree* rather than their history, and why
`.gitignore` now excludes weight extensions **path-independently**:

```
*.pth  *.pt  *.ckpt  *.safetensors  *.bin  *.gguf  *.onnx
```

A model weight is never a source file, whichever directory a script happened to
be standing in when it downloaded one.

## Upstream source

Separate from weights, and also never committed:

```bash
scripts/vendor/bootstrap.sh
```

Clones MelodyT5, MIDI-RWKV and rwkv.cpp at the SHAs pinned in
[`third_party/MANIFEST.md`](../../third_party/MANIFEST.md), and **announces two
deliberate skips**: `MIDIMetrics` (no detected licence, evaluation-only) and
`RWKV-PEFT` (training-only). Seeing those lines means it is working correctly.

MIDI-RWKV's submodules are SSH URLs to personal forks, so a plain
`--recurse-submodules` fails for any anonymous clone. The script rewrites them
to HTTPS and initialises only what inference needs.
