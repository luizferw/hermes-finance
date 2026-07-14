#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"

backup_file="$(./scripts/db-backup.sh)"
echo "backup created: $backup_file"
if [ "${KOSH_ALLOW_DEDUPLICATION:-false}" = "true" ]; then
  KOSH_BACKUP_CREATED=true KOSH_BACKUP_FILE="$backup_file" ./scripts/db-dedupe-imported-transactions.sh
fi
pnpm db:migrate
./scripts/db-verify-schema.sh
KOSH_PROTECTED_BACKUP="$backup_file" ./scripts/db-prune-backups.sh
