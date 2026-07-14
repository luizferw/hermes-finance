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

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At <<'SQL'
select 'ok: database reachable';

do $$
declare
  duplicate_count integer;
begin
  select count(*) into duplicate_count
  from (
    select account_id, import_hash
    from transactions
    where import_hash is not null and import_file_id is not null and deleted_at is null
    group by account_id, import_hash
    having count(*) > 1
  ) d;
  if duplicate_count > 0 then
    raise exception 'duplicate transaction import hashes: % group(s)', duplicate_count;
  end if;

  select count(*) into duplicate_count
  from (
    select account_id, external_id
    from transactions
    where external_id is not null and deleted_at is null
    group by account_id, external_id
    having count(*) > 1
  ) d;
  if duplicate_count > 0 then
    raise exception 'duplicate transaction external ids: % group(s)', duplicate_count;
  end if;
end $$;

do $$
declare
  missing text[];
begin
  select array_agg(name order by name) into missing
  from (
    values
      ('accounts_currency_code_check'),
      ('account_balances_currency_code_check'),
      ('transactions_amount_sign_check'),
      ('transactions_transfer_account_check'),
      ('transactions_account_owner_fk'),
      ('recurring_account_owner_fk'),
      ('ai_messages_conversation_owner_fk'),
      ('bills_due_day_check')
  ) as required(name)
  where not exists (
    select 1 from pg_constraint c where c.conname = required.name
  );
  if missing is not null then
    raise exception 'missing constraints: %', array_to_string(missing, ', ');
  end if;
end $$;

do $$
declare
  missing text[];
begin
  select array_agg(name order by name) into missing
  from (
    values
      ('transactions_import_hash_unique'),
      ('transactions_external_id_unique'),
      ('accounts_id_user_unique'),
      ('ai_conversations_id_user_unique'),
      ('import_rows_file_row_unique')
  ) as required(name)
  where to_regclass(required.name) is null;
  if missing is not null then
    raise exception 'missing indexes: %', array_to_string(missing, ', ');
  end if;
end $$;

select 'ok: production guardrails present';
SQL
