#!/usr/bin/env bash
#
# Production deploy on a single Linux server.
#
#   cp .env.production.example .env   # then edit SITE_DOMAIN
#   ./scripts/bootstrap.sh
#   ./scripts/deploy.sh

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ok()  { printf '  ✓ %s\n' "$*"; }

[ -f .env ] || die ".env not found. Copy .env.production.example to .env and edit it."
# shellcheck disable=SC1091
set -a; . ./.env; set +a

[ -n "${SITE_DOMAIN:-}" ] || die "SITE_DOMAIN is not set in .env"
[ -n "${PUBLISH_SECRET:-}" ] || die "PUBLISH_SECRET is not set in .env"
[ -n "${POSTGRES_PASSWORD:-}" ] || die "POSTGRES_PASSWORD is not set in .env"
ok "configuration for ${SITE_DOMAIN}"

[ -f models/melodyt5/weights.pth ] || die "model weights are missing. Run ./scripts/bootstrap.sh"
ok "model weights present"

printf '\n  Building and starting…\n\n'
docker compose -f compose.yaml -f compose.production.yaml up -d --build

printf '\n  Waiting for health…'
for _ in $(seq 1 90); do
  if docker compose -f compose.yaml -f compose.production.yaml ps --format json 2>/dev/null \
      | grep -q '"Health":"healthy"'; then
    printf '\n\n'
    docker compose -f compose.yaml -f compose.production.yaml ps
    printf '\n  Live at https://%s\n\n' "$SITE_DOMAIN"
    exit 0
  fi
  printf '.'; sleep 3
done

printf '\n\n  Not healthy yet. Check:\n    docker compose -f compose.yaml -f compose.production.yaml logs -f\n'
exit 1
