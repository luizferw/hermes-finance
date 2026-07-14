#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"

command -v psql >/dev/null || {
  echo "psql not found. Install PostgreSQL client tools." >&2
  exit 1
}
command -v pg_restore >/dev/null || {
  echo "pg_restore not found. Install PostgreSQL client tools." >&2
  exit 1
}
test -f "$BACKUP_FILE" || {
  echo "backup file not found: $BACKUP_FILE" >&2
  exit 1
}

tables="$(
  psql "$DATABASE_URL" -Atc \
    "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE';"
)"
if [ "$tables" != "0" ] && [ "${KOSH_RESTORE_ALLOW_NON_EMPTY:-false}" != "true" ]; then
  echo "target database is not fresh ($tables public tables). Refusing restore." >&2
  echo "Set KOSH_RESTORE_ALLOW_NON_EMPTY=true only for a deliberate overwrite drill." >&2
  exit 1
fi

pg_restore --no-owner --no-acl --dbname "$DATABASE_URL" "$BACKUP_FILE"
./scripts/db-verify-schema.sh
