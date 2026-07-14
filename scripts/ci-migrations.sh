#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${KOSH_CI_ALLOW_DATABASE_RESET:?set KOSH_CI_ALLOW_DATABASE_RESET=true for a disposable database}"
[ "$KOSH_CI_ALLOW_DATABASE_RESET" = "true" ] || {
  echo "Refusing to reset the database without KOSH_CI_ALLOW_DATABASE_RESET=true." >&2
  exit 1
}
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }

reset_database() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop schema if exists public cascade;
drop schema if exists drizzle cascade;
create schema public;
SQL
}

reset_database
pnpm db:migrate
pnpm db:verify

previous="$(mktemp -d)"
trap 'rm -rf "$previous"' EXIT
cp -R packages/db/migrations/. "$previous/"
node --input-type=module - "$previous" <<'NODE'
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const journalPath = join(dir, "meta", "_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const latest = journal.entries.pop();
if (!latest) throw new Error("No migration available for upgrade rehearsal");
writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
rmSync(join(dir, `${latest.tag}.sql`));
rmSync(join(dir, "meta", `${String(latest.idx).padStart(4, "0")}_snapshot.json`), {
  force: true,
});
NODE

reset_database
KOSH_MIGRATIONS_DIR="$previous" pnpm db:migrate
pnpm db:migrate
pnpm db:verify
