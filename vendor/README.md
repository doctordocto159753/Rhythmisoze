# vendor/

Upstream model source, fetched at the exact SHAs pinned in
[`../third_party/MANIFEST.md`](../third_party/MANIFEST.md).

**Nothing here is committed.** The directory is gitignored apart from this file.

```bash
scripts/vendor/bootstrap.sh      # Linux, macOS, Git Bash
pwsh scripts/vendor/bootstrap.ps1  # Windows
```

## Why a script instead of git submodules

Submodules are the preferred strategy and are used where they work. They do not
work for MIDI-RWKV, and the reason is a property of that repository:

- its `.gitmodules` points at three **personal forks over SSH**
  (`git@github.com:...`), so `--recurse-submodules` fails for any anonymous
  clone — CI, a fresh checkout, a Docker build;
- one of those forks, **MIDIMetrics, has no detected licence**, and it is an
  *evaluation* dependency this pipeline does not need. Vendoring it to satisfy a
  recursive init would put unlicensed code in the tree.

Section 4 of the brief permits this deviation provided it is documented. The
script takes each whole repository at its pinned SHA, rewrites SSH URLs to
HTTPS, initialises only the submodule inference actually uses, and skips
MIDIMetrics and RWKV-PEFT — announcing both skips rather than quietly omitting
them.

`rwkv.cpp` is taken from **upstream `RWKV/rwkv.cpp`**, not the fork MIDI-RWKV
pins. That decision, and the porting cost it may carry, is recorded in the
manifest.

## What lands here

| Path | Upstream | Pinned |
|---|---|---|
| `melodyt5/` | `sanderwood/melodyt5` | `9fc0e7dd…` |
| `midi-rwkv/` | `christianazinn/MIDI-RWKV` | `7c94e9e2…` |
| `rwkv.cpp/` | `RWKV/rwkv.cpp` | `14663c83…` |

Model **weights** are a separate concern: see [`../models/`](../models/) and
`scripts/models/bootstrap.{sh,ps1}`.
