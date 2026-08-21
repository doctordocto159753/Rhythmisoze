#!/usr/bin/env bash
#
# Back up the two things that cannot be regenerated.
#
# Model weights are deliberately NOT backed up: they are reproducibly
# downloadable and verified by sha256, so a copy would be 1.4 GB of duplicated
# bytes with no recovery value. What matters is the database and the published
# objects, because those are the users' work.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-$ROOT/backups}/$STAMP"
mkdir -p "$OUT"

COMPOSE=(docker compose -f compose.yaml)
[ -f compose.production.yaml ] && [ -n "${SITE_DOMAIN:-}" ] && COMPOSE+=(-f compose.production.yaml)

printf '  backing up to %s\n' "$OUT"

# Postgres: a custom-format dump, which restores selectively and compresses.
"${COMPOSE[@]}" exec -T postgres pg_dump -U rhythmisoze -Fc rhythmisoze > "$OUT/database.dump"
printf '  ✓ database  (%s)\n' "$(du -h "$OUT/database.dump" | cut -f1)"

# Published objects: streamed straight out of the volume so the app need not be
# stopped and no temporary copy is made inside the container.
"${COMPOSE[@]}" run --rm --no-deps -T -v "$OUT:/backup" web \
  tar czf /backup/objects.tar.gz -C /data objects 2>/dev/null \
  || docker run --rm -v rhythmisoze_objects:/data -v "$OUT:/backup" alpine \
       tar czf /backup/objects.tar.gz -C /data objects
printf '  ✓ objects   (%s)\n' "$(du -h "$OUT/objects.tar.gz" | cut -f1)"

# What this backup came from, so a restore knows what it is restoring into.
cat > "$OUT/manifest.json" <<JSON
{
  "createdAt": "$STAMP",
  "commit": "$(git rev-parse HEAD 2>/dev/null || echo unknown)",
  "branch": "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)",
  "note": "Model weights are not included: they are reproducibly downloadable and sha256-verified by scripts/models/bootstrap.sh."
}
JSON
printf '  ✓ manifest\n\n  Restore with: ./scripts/restore.sh %s\n\n' "$OUT"
