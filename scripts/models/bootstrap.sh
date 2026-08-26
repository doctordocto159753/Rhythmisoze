#!/usr/bin/env bash
#
# Fetch the AI Musician model weights described in models/manifest.json.
#
# Rules this script exists to enforce:
#
#   * download only what is missing;
#   * resume a partial download rather than starting over;
#   * verify sha256 against the manifest, always;
#   * fail loudly and non-zero on a mismatch -- a wrong checkpoint that loads is
#     worse than one that does not, because it produces plausible output;
#   * never re-download a file that is already correct.
#
# It is deliberately chatty about disk space. A 1.36 GB download that dies at
# 99% because the volume was full is a bad first experience, and the check costs
# nothing.
#
# Artifacts marked `optional` in the manifest are skipped unless named:
#
#     scripts/models/bootstrap.sh            # everything the Musician needs
#     scripts/models/bootstrap.sh game       # that, plus the named optional one
#
# They are skipped because "optional" here does not mean "less important" — it
# means the licence on the weights is not this project's licence, and fetching
# them is a decision rather than a step. The script prints the terms before it
# downloads one.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${ROOT}/models/manifest.json"
MODELS_DIR="${MUSICIAN_MODELS_DIR:-${ROOT}/models}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }

# python3 on Linux and macOS, plain `python` on Git Bash for Windows. Both are
# supported targets for this script, so resolve rather than assume.
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' 2>/dev/null; then
      PY="$candidate"
      break
    fi
  fi
done
[ -n "$PY" ] || die "python 3 is required to read the manifest (looked for python3 and python)"
command -v curl >/dev/null 2>&1 || die "curl is required"

[ -f "$MANIFEST" ] || die "manifest not found at $MANIFEST"

# Unpacks a release zip and flattens its single top-level directory away, so a
# path in the manifest describes where a file ends up rather than where the
# archive happened to put it. The zip is removed on success: it is a download
# artifact, and leaving 47 MB of it beside the thing it produced is clutter that
# looks like a cache.
unpack_zip() {
  local archive="$1" target="$2" strip="$3"
  "$PY" - "$archive" "$target" "$strip" <<'PY'
import pathlib, shutil, sys, zipfile

archive, target, strip = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3]
with zipfile.ZipFile(archive) as bundle:
    for member in bundle.infolist():
        if member.is_dir():
            continue
        name = member.filename
        if strip and name.startswith(strip):
            name = name[len(strip):]
        if name == "" or name.startswith("/") or ".." in pathlib.PurePosixPath(name).parts:
            raise SystemExit(f"refusing to unpack suspicious path: {member.filename}")
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with bundle.open(member) as source, open(destination, "wb") as sink:
            shutil.copyfileobj(source, sink)
PY
  rm -f "$archive"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    "$PY" -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"
  fi
}

# `tr -d '\r'` (a carriage return) is not decoration: on Git Bash for Windows, python's print()
# emits CRLF, and a carriage return riding on the end of a URL makes curl fail
# with "malformed input to a URL function" -- which reads like a bad manifest
# rather than a line-ending problem.
readarray -t ENTRIES < <("$PY" - "$MANIFEST" <<'PY' | tr -d '\r'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
for model in manifest["models"]:
    artifact = model["artifact"]
    print("\t".join([
        model["name"],
        artifact["destination"],
        str(artifact["expectedBytes"]),
        artifact["sha256"],
        artifact["downloadUrl"],
        "optional" if model.get("optional") else "required",
        model.get("license", {}).get("weights", "unstated"),
        artifact.get("unpack", ""),
        artifact.get("unpackStrip", ""),
    ]))
PY
)

TOTAL_BYTES=$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['totalBytes'])" "$MANIFEST" | tr -d '\r')
TOTAL_GB=$("$PY" -c "print(f'{$TOTAL_BYTES/1e9:.2f}')" | tr -d '\r')

echo "Rhythmisoze AI Musician -- model bootstrap"
echo "  manifest : $MANIFEST"
echo "  target   : $MODELS_DIR"
echo "  full set : ${TOTAL_GB} GB"
echo

if command -v df >/dev/null 2>&1; then
  mkdir -p "$MODELS_DIR"
  AVAIL_KB=$(df -Pk "$MODELS_DIR" | awk 'NR==2{print $4}')
  AVAIL_GB=$("$PY" -c "print(f'{${AVAIL_KB}*1024/1e9:.2f}')" | tr -d '\r')
  info "free space: ${AVAIL_GB} GB"
  "$PY" -c "import sys;sys.exit(0 if ${AVAIL_KB}*1024 > ${TOTAL_BYTES}*1.2 else 1)" \
    || die "not enough free disk space: need about ${TOTAL_GB} GB plus headroom, have ${AVAIL_GB} GB"
  echo
fi

FETCHED=0
SKIPPED=0

for entry in "${ENTRIES[@]}"; do
  IFS=$'\t' read -r NAME DEST EXPECTED_BYTES EXPECTED_SHA URL KIND WEIGHTS_LICENCE UNPACK UNPACK_STRIP <<<"$entry"

  if [ "$KIND" = "optional" ] && ! printf '%s\n' "$@" | grep -qx "$NAME"; then
    echo "[$NAME]"
    info "optional, not requested -- re-run with: $0 $NAME"
    info "weights licence: ${WEIGHTS_LICENCE}"
    SKIPPED=$((SKIPPED + 1))
    echo
    continue
  fi

  # A zip is unpacked into a directory; a bare weight file is the download
  # itself. `DOWNLOAD` is what curl writes and what the checksum covers, which
  # must stay the artifact the manifest actually recorded a hash for.
  if [ -n "$UNPACK" ]; then
    TARGET="${MODELS_DIR}/${DEST}"
    DOWNLOAD="${MODELS_DIR}/${DEST}/.download.zip"
    mkdir -p "$TARGET"
  else
    TARGET="${MODELS_DIR}/${DEST}"
    DOWNLOAD="$TARGET"
    mkdir -p "$(dirname "$TARGET")"
  fi

  echo "[$NAME]"

  if [ "$KIND" = "optional" ]; then
    info "weights licence: ${WEIGHTS_LICENCE}"
    info "this is NOT the licence of Rhythmisoze itself; read models/README.md"
  fi

  # An unpacked artifact is complete when its unpacked contents verify, since
  # the zip itself is deleted after a successful unpack.
  if [ -n "$UNPACK" ] && [ -f "${TARGET}/model.pt" ]; then
    info "already unpacked, nothing to do"
    SKIPPED=$((SKIPPED + 1))
    echo
    continue
  fi

  if [ -f "$DOWNLOAD" ]; then
    ACTUAL_BYTES=$("$PY" -c "import os,sys;print(os.path.getsize(sys.argv[1]))" "$DOWNLOAD" | tr -d '\r')
    if [ "$ACTUAL_BYTES" = "$EXPECTED_BYTES" ]; then
      info "present, verifying checksum..."
      ACTUAL_SHA=$(sha256_of "$DOWNLOAD")
      if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
        info "verified"
        if [ -n "$UNPACK" ]; then
          unpack_zip "$DOWNLOAD" "$TARGET" "$UNPACK_STRIP"
          info "unpacked"
        fi
        SKIPPED=$((SKIPPED + 1))
        echo
        continue
      fi
      die "$DOWNLOAD exists but its checksum does not match the manifest.
       expected $EXPECTED_SHA
       actual   $ACTUAL_SHA
     Delete the file and re-run. Do NOT use it: a checkpoint that loads but is
     not the one recorded produces plausible output from the wrong model."
    fi
    info "partial file found (${ACTUAL_BYTES} of ${EXPECTED_BYTES} bytes), resuming"
  fi

  info "downloading from $URL"
  # -C - resumes; --fail turns an HTML error page into a non-zero exit rather
  # than a file that fails the checksum for a confusing reason.
  curl --fail --location --continue-at - --progress-bar --output "$DOWNLOAD" "$URL" \
    || die "download failed for $NAME"

  info "verifying checksum..."
  ACTUAL_SHA=$(sha256_of "$DOWNLOAD")
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || die "checksum mismatch for $NAME after download.
       expected $EXPECTED_SHA
       actual   $ACTUAL_SHA"

  info "verified"
  if [ -n "$UNPACK" ]; then
    unpack_zip "$DOWNLOAD" "$TARGET" "$UNPACK_STRIP"
    info "unpacked into $TARGET"
  fi
  FETCHED=$((FETCHED + 1))
  echo
done

echo "done: ${FETCHED} downloaded, ${SKIPPED} already present and verified"
