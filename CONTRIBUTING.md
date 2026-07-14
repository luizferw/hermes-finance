# Contributing to Kosh

Kosh is self-hosted personal-finance software. Prefer small, reviewable changes
that preserve privacy, financial correctness, and straightforward deployment.

## Setup

Follow the [local development instructions](README.md#local-development), then
run the relevant checks before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:operations
pnpm build
```

Use a disposable database for migrations, seed data, and HTTP smoke tests.
`pnpm db:seed` replaces the demo user's related records.

## Project layout

```text
apps/web          Next.js application, API routes, auth, and jobs
packages/db       Drizzle schema, migrations, backup helpers, and seed data
packages/domain   Ledger, import, budget, report, and parsing rules
scripts           Operational and CI verification scripts
```

## Contributions

- Keep routes thin: validate input, authorize the current user, delegate, and
  return a safe response.
- Preserve exact money arithmetic and ownership checks. Add a focused test for
  changes to authorization, calculations, migrations, imports, or encryption.
- Do not commit `.env` files, backups, exports, production data, tokens, or
  machine-specific tool configuration.
- Document user-visible configuration and operational changes in the same PR.
- Discuss broad product changes or public API changes in an issue first.

## Pull requests

Use the pull-request template, explain the behavior change, and include the
checks you ran. By contributing, you agree that your work is licensed under the
[AGPL-3.0-only license](LICENSE).

## Security

Do not open a public issue for a vulnerability. Use the private process in
[SECURITY.md](SECURITY.md).
