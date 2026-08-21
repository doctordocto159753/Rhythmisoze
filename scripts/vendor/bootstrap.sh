#!/usr/bin/env bash
#
# Fetch upstream model source into vendor/, at the exact SHAs recorded in
# third_party/MANIFEST.md.
#
# ## Why this is a script and not `git submodule`
#
# Submodules are the preferred strategy and are used where they work. They do
# not work for MIDI-RWKV, for a reason that is a property of that repository
# rather than a preference of ours:
#
#   * its .gitmodules points at three *personal forks* over **SSH**
#     (git@github.com:...), so `--recurse-submodules` fails outright for any
#     anonymous clone -- CI, a fresh checkout, a Docker build;
#   * one of those forks, MIDIMetrics, has **no detected licence**, and it is an
#     evaluation dependency this pipeline does not need. Vendoring it would put
#     unlicensed code in our tree to satisfy a recursive init.
#
# Section 4 of the brief allows exactly this deviation provided it is
# documented: we take the whole repository at the pinned SHA and initialise
# **none** of its submodules. That deviation is recorded here and in
# third_party/MANIFEST.md.
#
# ## Why none, rather than "only rwkv.cpp"
#
# This script used to rewrite the SSH URLs to HTTPS and initialise MIDI-RWKV's
# own `rwkv.cpp` submodule. On a normal Windows machine with no GitHub SSH key
# that still failed with "Host key verification failed", because the rewrite is
# local config on the superproject and the submodule clone did not always honour
# it -- so the documented, supported path did not work on the platform it was
# written for.
#
# It is also redundant. MIDI-RWKV's `rwkv.cpp` is a *personal fork*; this project
# deliberately vendors **upstream RWKV/rwkv.cpp** as its own top-level entry
# below, and that is the one anything here would use. And rwkv.cpp is not on the
# V1 path at all: the verified V1 runtime is the Python `rwkv` package (see
# docs/architecture/musician-runtime-adr.md), with rwkv.cpp a deferred
# optimisation that only engages when a converted GGML weight is present.
#
# What inference actually needs from this repository is one file --
# `train/tokenizer/tokenizer_with_acs.json` -- which lives in the main tree, not
# in any submodule. So initialising nothing costs nothing and removes the only
# step that required SSH.
#
# Nothing fetched here is committed. vendor/ is gitignored.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENDOR="${ROOT}/vendor"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }

command -v git >/dev/null 2>&1 || die "git is required"

mkdir -p "$VENDOR"

# name | url | pinned sha | recurse?
REPOS=(
  "melodyt5|https://github.com/sanderwood/melodyt5|9fc0e7dd02ba10a77b46f9d4a669451f17885fbc|no"
  "midi-rwkv|https://github.com/christianazinn/MIDI-RWKV|7c94e9e2980d1f3cdb0d3a9ca2780ef0a5af6530|none-by-design"
  "rwkv.cpp|https://github.com/RWKV/rwkv.cpp|14663c83b6aba4885a47c1fba91204efc74a49d3|yes"
)

echo "Rhythmisoze AI Musician -- vendor bootstrap"
echo "  target: $VENDOR"
echo

for entry in "${REPOS[@]}"; do
  IFS='|' read -r NAME URL SHA RECURSE <<<"$entry"
  TARGET="${VENDOR}/${NAME}"

  echo "[$NAME]"

  if [ -d "${TARGET}/.git" ]; then
    CURRENT="$(git -C "$TARGET" rev-parse HEAD)"
    if [ "$CURRENT" = "$SHA" ]; then
      info "already at $SHA"
      echo
      continue
    fi
    info "at $CURRENT, moving to $SHA"
    git -C "$TARGET" fetch --quiet origin "$SHA" || git -C "$TARGET" fetch --quiet origin
  else
    info "cloning $URL"
    # No --depth: a pinned SHA is often not the branch tip, and a shallow clone
    # then cannot check it out. Correctness over a few seconds.
    git clone --quiet "$URL" "$TARGET"
  fi

  git -C "$TARGET" checkout --quiet "$SHA" \
    || die "$NAME has no commit $SHA. The manifest and upstream disagree; do not guess."

  ACTUAL="$(git -C "$TARGET" rev-parse HEAD)"
  [ "$ACTUAL" = "$SHA" ] || die "$NAME checked out $ACTUAL, expected $SHA"
  info "pinned at $SHA"

  case "$RECURSE" in
    yes)
      git -C "$TARGET" submodule update --init --recursive --quiet
      ;;
    none-by-design)
      # Every submodule here is an SSH URL to a personal fork, and none is used.
      # Stated rather than merely omitted, so the exclusion is visible to whoever
      # reads the output and wonders where they went.
      info "using the tokenizer and training source from the main tree only"
      info "SKIPPED rwkv.cpp (personal fork): upstream RWKV/rwkv.cpp is vendored separately below"
      info "SKIPPED MIDIMetrics: no detected licence, and not needed for inference"
      info "SKIPPED RWKV-PEFT: training-only"
      info "no SSH access is required by this step"
      ;;
    *)
      info "no submodules"
      ;;
  esac
  echo
done

echo "done. Nothing here is committed -- vendor/ is gitignored."
echo "Model weights are separate: run scripts/models/bootstrap.sh"
