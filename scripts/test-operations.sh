#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for n in 1 2 3 4 5; do
  touch "$tmp/kosh-2026070${n}T000000Z.dump"
done

protected="$tmp/kosh-20260702T000000Z.dump"
BACKUP_DIR="$tmp" KOSH_BACKUP_RETENTION_COUNT=2 KOSH_PROTECTED_BACKUP="$protected" \
  ./scripts/db-prune-backups.sh

test -f "$protected"
test -f "$tmp/kosh-20260705T000000Z.dump"
test "$(find "$tmp" -name 'kosh-*.dump' | wc -l)" -eq 2
if BACKUP_DIR="$tmp" KOSH_BACKUP_RETENTION_COUNT=0 ./scripts/db-prune-backups.sh 2>/dev/null; then
  echo "zero backup retention was accepted" >&2
  exit 1
fi
