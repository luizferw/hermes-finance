# Kosh Operations

Kosh is finance software. Do not migrate or update production without a restorable database backup and the encryption key.

## First Deploy

1. Generate secrets:

```bash
export POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr '/+' '_-')"
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export KOSH_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export APP_URL="https://kosh.example.com"
export DATABASE_URL="postgres://kosh:${POSTGRES_PASSWORD}@db:5432/kosh"
```

2. Start from scratch:

```bash
docker compose up -d --build
docker compose ps
curl -fsS -I "$APP_URL/api/system/health"
```

3. Back up `BETTER_AUTH_SECRET` and `KOSH_ENCRYPTION_KEY` in a password manager or offline secret store. If `KOSH_ENCRYPTION_KEY` is lost, encrypted account masks, UPI/UTR references, and notes are unrecoverable.

## Backup

Use PostgreSQL custom format so restores are deterministic and `pg_restore` can validate the archive:

```bash
export DATABASE_URL="postgres://..."
pnpm db:backup
```

When using the Compose-managed database, run the same command inside the
`migrate` service so hostname `db` resolves:

```bash
docker compose run --rm --no-deps migrate pnpm db:backup
```

The script validates a temporary archive, then atomically publishes it as
`backups/kosh-<timestamp>-<id>.dump` with owner-only permissions. Existing
backups are never overwritten. Copy it off-host and encrypt the destination.

After a successful `pnpm db:migrate:safe`, Kosh keeps the newest 10 database
dumps and prunes older `kosh-*.dump` files. Set
`KOSH_BACKUP_RETENTION_COUNT` to another positive integer to change this, or
run `pnpm db:backup:prune` manually. Pruning runs only after migration and
schema verification succeed, and the backup made for that migration is always
protected from deletion.

Kosh does not currently write user attachments to the Docker storage volume;
the PostgreSQL archive is the user-data backup. Revisit this procedure if a
future release adds persistent file uploads.

## Restore Into A Fresh Database

Create an empty target database, then restore:

```bash
export DATABASE_URL="postgres://target-user:target-pass@target-host:5432/kosh_restore"
export BACKUP_FILE="backups/kosh-20260705T120000Z.dump"
pnpm db:restore:fresh
```

The restore script refuses non-empty databases unless `KOSH_RESTORE_ALLOW_NON_EMPTY=true` is explicitly set. After restore, start Kosh with the original `BETTER_AUTH_SECRET` and original `KOSH_ENCRYPTION_KEY`.

## Update

Run app checks from the source checkout:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

For a database directly reachable from the host:

```bash
export DATABASE_URL="postgres://..."
pnpm db:migrate:safe
```

For the Compose-managed database, `migrate` runs the safe migration before
`web` starts:

```bash
docker compose up -d --build
docker compose ps
curl -fsS -I "$APP_URL/api/system/health"
```

Both paths create a custom-format backup, run Drizzle migrations, and verify
production guardrail constraints and indexes.

## Repair Storage Ownership After Upgrading

Fresh volumes are owned by runtime UID/GID `1001:1001`. If an older
`kosh-storage` volume is root-owned, stop the web service and repair only that
mounted directory:

```bash
docker compose stop web
docker compose run --rm --no-deps --user root --entrypoint sh web \
  -c 'chown -R 1001:1001 /app/data/storage'
docker compose up -d web
```

`--no-deps` prevents the repair command from starting or touching PostgreSQL.
Fresh volumes do not need this repair.

If `pnpm db:verify` reports duplicate import hashes, inspect first:

```bash
pnpm db:forensics:duplicates
```

Only when the report shows exact duplicate imported transactions, run the gated cleanup through the safe migration path:

```bash
KOSH_ALLOW_DEDUPLICATION=true pnpm db:migrate:safe
```

This creates a backup first, soft-deletes only exact imported duplicates, recomputes affected balances, runs migrations, and verifies guardrails. It does not touch manually-created transactions.

## Rollback

If the app image is bad but migrations succeeded:

```bash
git checkout <previous-good-ref>
docker compose up -d --build web
curl -fsS -I "$APP_URL/api/system/health"
```

If a migration changed the database and rollback requires old schema/data, restore the pre-migration dump into a fresh database and point `DATABASE_URL` at it. Do not run ad-hoc down migrations on production finance data.

## Migration Failure Recovery

1. Stop web traffic:

```bash
docker compose stop web
```

2. Preserve the failed database for inspection:

```bash
pnpm db:backup
```

3. Restore the pre-migration backup into a fresh database:

```bash
export DATABASE_URL="postgres://..."
export BACKUP_FILE="backups/kosh-before-migration.dump"
pnpm db:restore:fresh
```

4. Fix the migration, run it on a restored scratch database, then retry production.

## Encryption Key Backup

`KOSH_ENCRYPTION_KEY` is a base64 32-byte AES-256-GCM key. Store it separately from database backups. Key rotation is currently manual: add a new key variable, write a one-time decrypt-with-old/encrypt-with-new backfill, verify restore, then deploy. Until that exists, treat key loss as permanent loss of encrypted fields.

## Health Checks

```bash
curl -fsS -I "$APP_URL/api/system/health"
```

Authenticated operators can open `/settings/health` or call `GET /api/system/health` from a signed-in session for DB/job details.

## Release Checklist

- `pnpm lint` passes.
- `pnpm typecheck` passes.
- `pnpm test` passes.
- Migration dry run completed on a restored scratch database.
- `pnpm db:backup` created a pre-migration backup.
- `pnpm db:restore:fresh` tested the backup against a fresh database.
- `pnpm db:migrate:safe` completed.
- `docker compose up -d --build` tested from scratch.
- `curl -fsS -I "$APP_URL/api/system/health"` returns 200.
- `BETTER_AUTH_SECRET` and `KOSH_ENCRYPTION_KEY` are backed up.
