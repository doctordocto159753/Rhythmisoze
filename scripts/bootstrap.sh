#!/usr/bin/env bash
#
# One-time setup: upstream source, model weights, and a .env to start from.
#
# Deliberately does NOT build containers or start anything. Bootstrapping
# downloads about 1.4 GB and takes a while; a script that then silently started
# a stack would make it impossible to tell which step failed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
die()  { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

info "Rhythmisoze — self-hosted bootstrap"

command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Engine (Linux) or Docker Desktop (Windows/macOS)."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (\`docker compose\`, not \`docker-compose\`)."
ok "docker $(docker --version | sed 's/Docker version //;s/,.*//')"

info "1/3  Upstream model source"
bash "$ROOT/scripts/vendor/bootstrap.sh"

info "2/3  Model weights (~1.4 GB)"
bash "$ROOT/scripts/models/bootstrap.sh"

info "3/3  Configuration"
if [ -f "$ROOT/.env" ]; then
  ok ".env already exists, leaving it alone"
else
  cp "$ROOT/.env.production.example" "$ROOT/.env"
  # A publish secret nobody chose is better than a default everybody shares.
  if command -v openssl >/dev/null 2>&1; then
    secret="$(openssl rand -hex 32)"
    maintenance="$(openssl rand -hex 32)"
    postgres="$(openssl rand -hex 16)"
    sed -i.bak \
      -e "s|^PUBLISH_SECRET=.*|PUBLISH_SECRET=${secret}|" \
      -e "s|^MAINTENANCE_TOKEN=.*|MAINTENANCE_TOKEN=${maintenance}|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${postgres}|" \
      "$ROOT/.env"
    rm -f "$ROOT/.env.bak"
    ok "generated .env with fresh secrets"
  else
    ok "created .env — set PUBLISH_SECRET, MAINTENANCE_TOKEN and POSTGRES_PASSWORD yourself"
  fi
fi

info "Done."
cat <<'NEXT'
  Next:
    local        ./scripts/start-local.sh
    production   edit .env (SITE_DOMAIN), then ./scripts/deploy.sh
    verify       ./scripts/verify-real-stack.sh
NEXT
