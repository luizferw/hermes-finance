#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"

if [ "${KOSH_ALLOW_DEDUPLICATION:-false}" != "true" ]; then
  echo "Refusing dedupe: set KOSH_ALLOW_DEDUPLICATION=true after reviewing the forensic report." >&2
  exit 1
fi

if [ "${KOSH_BACKUP_CREATED:-false}" != "true" ]; then
  if [ -z "${KOSH_BACKUP_FILE:-}" ] || [ ! -f "$KOSH_BACKUP_FILE" ]; then
    echo "Refusing dedupe: run pnpm db:backup first or use pnpm db:migrate:safe." >&2
    exit 1
  fi
fi

command -v psql >/dev/null || {
  echo "psql not found. Install PostgreSQL client tools." >&2
  exit 1
}

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

create temp table kosh_dedupe_victims on commit drop as
with ranked as (
  select
    t.*,
    row_number() over (
      partition by t.account_id, t.import_hash
      order by t.created_at, t.id
    ) as rn,
    first_value(t.amount_minor) over w as canonical_amount_minor,
    first_value(t.currency_code) over w as canonical_currency_code,
    first_value(t.date) over w as canonical_date,
    first_value(t.description) over w as canonical_description,
    first_value(t.raw_description) over w as canonical_raw_description,
    first_value(t.external_id) over w as canonical_external_id
  from transactions t
  where t.import_hash is not null
    and t.import_file_id is not null
    and t.deleted_at is null
  window w as (
    partition by t.account_id, t.import_hash
    order by t.created_at, t.id
    rows between unbounded preceding and unbounded following
  )
),
groups as (
  select account_id, import_hash
  from ranked
  group by account_id, import_hash
  having count(*) > 1
)
select
  r.id,
  r.account_id,
  r.transfer_account_id
from ranked r
join groups g
  on g.account_id = r.account_id
 and g.import_hash = r.import_hash
where r.rn > 1
  and r.import_file_id is not null
  and r.amount_minor = r.canonical_amount_minor
  and r.currency_code = r.canonical_currency_code
  and r.date = r.canonical_date
  and r.description = r.canonical_description
  and r.raw_description is not distinct from r.canonical_raw_description
  and r.external_id is not distinct from r.canonical_external_id;

create temp table kosh_dedupe_accounts on commit drop as
with updated as (
  update transactions t
  set deleted_at = now(),
      status = 'rejected',
      updated_at = now()
  from kosh_dedupe_victims v
  where t.id = v.id
  returning t.account_id, t.transfer_account_id
)
select account_id as id from updated
union
select transfer_account_id as id from updated where transfer_account_id is not null;

update accounts a
set current_balance_minor = a.opening_balance_minor
  + coalesce((
      select sum(t.amount_minor) from transactions t
      where t.account_id = a.id
        and t.status::text in ('imported','reviewed','posted')
        and t.deleted_at is null
    ), 0)
  + coalesce((
      select sum(-t.amount_minor) from transactions t
      where t.transfer_account_id = a.id
        and t.user_id = a.user_id
        and t.type = 'transfer'
        and t.status::text in ('imported','reviewed','posted')
        and t.deleted_at is null
    ), 0),
    updated_at = now()
where a.id in (select id from kosh_dedupe_accounts);

insert into account_balances (
  account_id,
  date,
  balance_minor,
  currency_code,
  created_at,
  updated_at
)
select
  a.id,
  current_date,
  a.current_balance_minor,
  a.currency_code,
  now(),
  now()
from accounts a
where a.id in (select id from kosh_dedupe_accounts)
on conflict (account_id, date) do update
set balance_minor = excluded.balance_minor,
    currency_code = excluded.currency_code,
    updated_at = now();

select 'soft_deleted_imported_duplicate_ids' as kind, coalesce(json_agg(id order by id), '[]'::json) as ids
from kosh_dedupe_victims;
select 'affected_account_ids' as kind, coalesce(json_agg(id order by id), '[]'::json) as ids
from kosh_dedupe_accounts;

commit;
SQL
