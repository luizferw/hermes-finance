#!/usr/bin/env bash
set -euo pipefail

retention="${KOSH_BACKUP_RETENTION_COUNT:-10}"
if ! [[ "$retention" =~ ^[1-9][0-9]*$ ]]; then
  echo "KOSH_BACKUP_RETENTION_COUNT must be a positive integer." >&2
  exit 1
fi

out_dir="${BACKUP_DIR:-backups}"
test -d "$out_dir" || exit 0
protected="${KOSH_PROTECTED_BACKUP:-}"
kept=0
if [ -n "$protected" ] && [ -f "$protected" ]; then
  kept=1
fi

mapfile -t backups < <(find "$out_dir" -maxdepth 1 -type f -name 'kosh-*.dump' -print | sort -r)
for file in "${backups[@]}"; do
  [ "$file" = "$protected" ] && continue
  if [ "$kept" -lt "$retention" ]; then
    kept=$((kept + 1))
  else
    rm -- "$file"
  fi
done
