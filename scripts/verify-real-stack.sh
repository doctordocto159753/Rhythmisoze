#!/usr/bin/env bash
#
# The real-model gate.
#
# Everything else in this repository can be green while the Musician is a
# well-tested illusion: the fake adapters satisfy every contract, the API
# returns valid JSON, and Compose validates. This script is the thing that says
# whether the actual published models load and generate.
#
# It is deliberately slow and deliberately noisy. It downloads nothing and
# assumes ./scripts/bootstrap.sh has already run.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pass=0; fail=0
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }

step "Environment"
printf '  os        : %s\n' "$(uname -s -r 2>/dev/null || echo windows)"
printf '  cpus      : %s\n' "$(nproc 2>/dev/null || echo '?')"
printf '  memory    : %s\n' "$(free -h 2>/dev/null | awk '/^Mem:/{print $2}' || echo '?')"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  printf '  gpu       : %s\n' "$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
  GPU=1
else
  printf '  gpu       : none (CPU is the supported baseline)\n'
  GPU=0
fi

step "1  Weights present and intact"
if bash scripts/models/bootstrap.sh >/tmp/rhy-models.log 2>&1; then
  ok "all artifacts verified against models/manifest.json"
else
  bad "model bootstrap failed — see /tmp/rhy-models.log"
  exit 1
fi

step "2  Upstream source vendored"
for d in vendor/melodyt5 vendor/midi-rwkv; do
  [ -d "$d" ] && ok "$d" || { bad "$d missing — run ./scripts/bootstrap.sh"; exit 1; }
done

step "3  Build and start the stack"
FILES=(-f compose.yaml)
[ "$GPU" = "1" ] && docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia && FILES+=(-f compose.gpu.yaml)
docker compose "${FILES[@]}" up --build -d
ok "stack up"

step "4  Readiness"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS http://localhost:"${WEB_PORT:-3000}"/api/musician/status 2>/dev/null | grep -q '"reachable":true'; then
    ready=1; break
  fi
  sleep 4
done
[ "$ready" = "1" ] && ok "musician reports reachable" || bad "musician never became reachable"

step "5  Model revisions the service actually loaded"
docker compose "${FILES[@]}" exec -T musician-api \
  python -c "import urllib.request,json; print(json.dumps(json.load(urllib.request.urlopen('http://localhost:8080/v1/models')),indent=2))" \
  2>/dev/null || bad "could not read /v1/models"

step "6  Real generation"
python3 scripts/spike/real_generation.py || bad "real generation failed"

step "Summary"
printf '  passed: %d   failed: %d\n\n' "$pass" "$fail"
[ "$fail" = "0" ] || exit 1
