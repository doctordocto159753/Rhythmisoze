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
# documented: we take the whole repository at the pinned SHA, rewrite the SSH
# URLs to HTTPS, initialise only the submodule we actually use, and skip
# MIDIMetrics entirely. That deviation is recorded here and in
# third_party/MANIFEST.md.
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
  "midi-rwkv|https://github.com/christianazinn/MIDI-RWKV|7c94e9e2980d1f3cdb0d3a9ca2780ef0a5af6530|selective"
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
    selective)
      # MIDI-RWKV's submodules are SSH URLs to personal forks. Rewrite to HTTPS
      # so an anonymous clone works at all, then take only what inference needs.
      git -C "$TARGET" config --local url."https://github.com/".insteadOf "git@github.com:"
      info "initialising rwkv.cpp only"
      if git -C "$TARGET" submodule update --init --quiet -- rwkv.cpp 2>/dev/null; then
        info "rwkv.cpp submodule initialised"
      else
        info "no rwkv.cpp submodule present; the standalone checkout above is used instead"
      fi
      # Stated rather than merely omitted, so the exclusion is visible to whoever
      # reads the output and wonders where it went.
      info "SKIPPED MIDIMetrics: no detected licence, and not needed for inference"
      info "SKIPPED RWKV-PEFT: training-only"
      ;;
    *)
      info "no submodules"
      ;;
  esac
  echo
done

echo "done. Nothing here is committed -- vendor/ is gitignored."
echo "Model weights are separate: run scripts/models/bootstrap.sh"
