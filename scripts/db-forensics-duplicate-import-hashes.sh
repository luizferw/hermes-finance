#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"

command -v psql >/dev/null || {
  echo "psql not found. Install PostgreSQL client tools." >&2
  exit 1
}

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
with duplicate_groups as (
  select account_id, import_hash, count(*) as duplicate_count
  from transactions
  where import_hash is not null and import_file_id is not null and deleted_at is null
  group by account_id, import_hash
  having count(*) > 1
)
select
  dg.duplicate_count,
  t.id,
  t.user_id,
  t.account_id,
  t.import_file_id as import_id,
  r.id as import_row_id,
  t.import_hash,
  t.amount_minor,
  t.currency_code as currency,
  t.date,
  t.merchant,
  t.description,
  t.created_at,
  t.updated_at
from duplicate_groups dg
join transactions t
  on t.account_id = dg.account_id
 and t.import_hash = dg.import_hash
left join import_rows r on r.transaction_id = t.id
where t.deleted_at is null
order by dg.duplicate_count desc, t.account_id, t.import_hash, t.created_at, t.id;
SQL
