#!/usr/bin/env bash
#
# Restore a backup produced by scripts/backup.sh.
#
# Destructive by nature: it replaces the current database and object store. It
# therefore refuses to run without an explicit confirmation, because "I meant
# to restore into staging" is a mistake people make once.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="${1:-}"
[ -n "$SRC" ] || { printf 'usage: %s <backup-directory>\n' "$0" >&2; exit 2; }
[ -f "$SRC/database.dump" ] || { printf 'no database.dump in %s\n' "$SRC" >&2; exit 2; }

printf '\n  This REPLACES the current database and published objects.\n'
printf '  Source: %s\n' "$SRC"
[ -f "$SRC/manifest.json" ] && sed 's/^/    /' "$SRC/manifest.json"
printf '\n  Type "restore" to continue: '
read -r answer
[ "$answer" = "restore" ] || { printf '  aborted\n'; exit 1; }

COMPOSE=(docker compose -f compose.yaml)

"${COMPOSE[@]}" up -d postgres
printf '  waiting for postgres'
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T postgres pg_isready -U rhythmisoze >/dev/null 2>&1 && break
  printf '.'; sleep 2
done
printf '\n'

# --clean drops objects before recreating them, so a restore into a populated
# database is a replacement rather than a merge that half-fails on conflicts.
"${COMPOSE[@]}" exec -T postgres pg_restore -U rhythmisoze -d rhythmisoze --clean --if-exists < "$SRC/database.dump"
printf '  ✓ database restored\n'

if [ -f "$SRC/objects.tar.gz" ]; then
  docker run --rm -v rhythmisoze_objects:/data -v "$(cd "$SRC" && pwd):/backup:ro" alpine \
    sh -c 'rm -rf /data/objects && tar xzf /backup/objects.tar.gz -C /data'
  printf '  ✓ objects restored\n'
fi

printf '\n  Restart the stack to pick it up:\n    ./scripts/start-local.sh\n\n'
