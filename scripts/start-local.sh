#!/usr/bin/env bash
#
# Bring the whole stack up locally. CPU by default; GPU when one is present.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILES=(-f compose.yaml)

# GPU is an accelerator, never a requirement. Detected rather than configured,
# so the same command works on both machines.
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  printf '  NVIDIA GPU detected: %s\n' "$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
    FILES+=(-f compose.gpu.yaml)
    printf '  using the GPU profile\n'
  else
    printf '  the NVIDIA container runtime is not installed; using CPU\n'
  fi
else
  printf '  no NVIDIA GPU detected; using CPU (this is the supported baseline)\n'
fi

if [ ! -d "$ROOT/models/melodyt5" ]; then
  printf '\n  Model weights are missing. Run ./scripts/bootstrap.sh first.\n'
  printf '  The stack will still start, and the Musician will report itself unavailable.\n\n'
fi

docker compose "${FILES[@]}" up --build -d

printf '\n  Waiting for the app'
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${WEB_PORT:-3000}/api/musician/status" >/dev/null 2>&1; then
    printf '\n\n  Ready:  http://localhost:%s\n\n' "${WEB_PORT:-3000}"
    exit 0
  fi
  printf '.'
  sleep 2
done

printf '\n\n  The app did not become ready. Logs:\n    docker compose logs -f web\n'
exit 1
