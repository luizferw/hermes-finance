#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"

command -v pg_dump >/dev/null || {
  echo "pg_dump not found. Install PostgreSQL client tools." >&2
  exit 1
}
command -v pg_restore >/dev/null || {
  echo "pg_restore not found. Install PostgreSQL client tools." >&2
  exit 1
}

umask 077
out_dir="${BACKUP_DIR:-backups}"
mkdir -p "$out_dir"
tmp="$(mktemp "$out_dir/.kosh-backup.XXXXXX")"
trap 'rm -f -- "$tmp"' EXIT
file="$out_dir/kosh-$(date -u +%Y%m%dT%H%M%SZ)-${tmp##*.}.dump"

pg_dump --format=custom --no-owner --no-acl --file "$tmp" "$DATABASE_URL"
if ! pg_restore --list "$tmp" >/dev/null; then
  echo "Backup archive validation failed." >&2
  exit 1
fi
mv -- "$tmp" "$file"
trap - EXIT
echo "$file"
