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
  IFS=$'\t' read -r NAME DEST EXPECTED_BYTES EXPECTED_SHA URL <<<"$entry"
  TARGET="${MODELS_DIR}/${DEST}"
  mkdir -p "$(dirname "$TARGET")"

  echo "[$NAME]"

  if [ -f "$TARGET" ]; then
    ACTUAL_BYTES=$("$PY" -c "import os,sys;print(os.path.getsize(sys.argv[1]))" "$TARGET" | tr -d '\r')
    if [ "$ACTUAL_BYTES" = "$EXPECTED_BYTES" ]; then
      info "present, verifying checksum..."
      ACTUAL_SHA=$(sha256_of "$TARGET")
      if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
        info "verified, nothing to do"
        SKIPPED=$((SKIPPED + 1))
        echo
        continue
      fi
      die "$TARGET exists but its checksum does not match the manifest.
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
  curl --fail --location --continue-at - --progress-bar --output "$TARGET" "$URL" \
    || die "download failed for $NAME"

  info "verifying checksum..."
  ACTUAL_SHA=$(sha256_of "$TARGET")
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || die "checksum mismatch for $NAME after download.
       expected $EXPECTED_SHA
       actual   $ACTUAL_SHA"

  info "verified"
  FETCHED=$((FETCHED + 1))
  echo
done

echo "done: ${FETCHED} downloaded, ${SKIPPED} already present and verified"
