# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Hermes Finance is a fork of [Kosh](https://github.com/kzekiue/kosh) (self-hosted personal finance)
extended with a deterministic forecast/planning engine. `origin` is the fork,
`upstream` is Kosh — see `docs/UPSTREAM.md`.

**The fork stays additive.** Kosh's infrastructure (auth, Next.js, Drizzle schema, jobs, backup,
MCP) is preserved as-is; Hermes work goes into `packages/forecast`, `packages/planning`, and new
tables. No existing Kosh table has been altered, which is what keeps upstream merges predictable.
Weigh that before editing anything under `packages/db/src/schema/` that Kosh already owned.

`docs/PRD.md` is the spec. Its numbered principles (R1–R9) and sections are load-bearing, and
commits cite them (`feat: ... (PRD §29, §9.10)`). Read the relevant section before implementing a
finance behavior — several non-obvious rules (a card purchase and its statement payment are
different events; a projection and a fact are never the same entity) come from there, not from the
code.

Docs are written in Portuguese; **code, comments, and commit messages are in English.** Commits are
conventional-commit subjects with a body explaining *why*, not a changelog of files.

## Commands

Node 22.13+, pnpm 11. Postgres 16 via `docker compose up -d db`.

```bash
pnpm dev                 # turbo dev
pnpm build               # turbo build (apps/web emits a standalone server)
pnpm lint                # eslint across the workspace
pnpm typecheck           # tsc --noEmit across the workspace
pnpm test                # vitest across all packages
pnpm test:operations     # backup-retention checks, no database
```

Two surprises in that list. `turbo.json` gives `typecheck` a `dependsOn: ["^build"]`, so
`pnpm typecheck` builds dependency packages first — it is not a cheap isolated check. And
`@kosh/db`'s `test` script is a stub (`echo 'no tests in @kosh/db' && exit 0`), so `pnpm test`
reports success for that package without running anything.

### Running one test

```bash
pnpm --filter web test modules/rules/pushdown-db.test.ts
pnpm --filter web test modules/rules/pushdown-db.test.ts -t "keyset"
pnpm --filter @kosh/domain test src/rules
```

`apps/web` has the only `vitest.config.ts`; the pure packages use vitest defaults.

**Do not invoke `vitest` or `next` directly from `apps/web`.** Both are wrapped by
`apps/web/scripts/with-root-env.mjs`, which loads the **root** `.env` (`../../.env`) before handing
off. Bypassing it fails with `DATABASE_URL is not set`, which reads like a missing config rather
than a wrong invocation.

Most `apps/web` tests need a live database and the seeded `demo@kosh.local` user — they resolve it
by email and throw `seed demo user missing` otherwise. Only `modules/agent/agent-unit.test.ts` and
`modules/system/env.test.ts` are pure. Everything under `packages/*` is pure.

### Database

```bash
pnpm db:generate         # drizzle-kit generate (after editing schema)
pnpm db:migrate          # apply migrations
pnpm db:migrate:safe     # backup, migrate, verify — use this on anything with real data
pnpm db:seed             # recreate demo data; DESTROYS the demo user's records
pnpm db:verify           # schema guardrails
pnpm db:studio
```

`pnpm --filter @kosh/db seed:prd-scenario` loads the PRD's worked scenario, which the finance tests
assert against. It has no root-level alias — the `--filter` form is the only way to invoke it.

`pnpm db:dedupe-imports` soft-deletes duplicate transactions and recalculates balances. It refuses
to run without `KOSH_ALLOW_DEDUPLICATION=true` *and* proof of a backup (`KOSH_BACKUP_CREATED=true`
or `KOSH_BACKUP_FILE`). Those gates are the review, so don't set them to get past an error.

### CI

`.github/workflows/ci.yml` gates on: migrate + seed + prd-scenario seed, then `typecheck`, `lint`,
`test`, `test:operations`, `build`, a fresh-and-upgrade migration rehearsal (`scripts/ci-migrations.sh`),
and a production-container check (`scripts/ci-container.sh`).

The HTTP smoke scripts (`scripts/verify-security.mjs`, `verify-flows.mjs`, `verify-onboarding.mjs`)
create real users and data against a running server; they are deliberately outside `pnpm test`.

### Local deploy

A **systemd user unit** owns the running app — `systemctl --user restart hermes-finance.service`
after `pnpm build`. It serves the standalone build on 127.0.0.1:3119 and brings up the `db`
container first. It has `Restart=always`, so killing the `next-server` PID by hand does not stop
it; systemd respawns it and a follow-up `pnpm start` then dies with `EADDRINUSE`.

## Architecture

### Package boundaries

```
apps/web ──► @kosh/db · @kosh/domain · @hermes-finance/forecast · @hermes-finance/planning
                                        ▲
                             planning ──┘
```

- `@kosh/db` — the **only** package that touches IO: Drizzle schema, client, migrations, seeds, crypto.
- `@kosh/domain` — pure: ledger, budgets, confidence, CSV/OFX parsing, rule matching, money helpers.
- `@hermes-finance/forecast` — pure: daily projection, recurrences, statements, installments.
- `@hermes-finance/planning` — safe-to-spend and payment-option comparison; depends on `forecast` only.

The pure packages know nothing of React, Next.js, Postgres, or MCP. They take normalized
integer-minor-unit facts and return deterministic results.

**This split has no mechanical enforcement** — no ESLint boundaries rule, no tsconfig path
restriction. Importing `@kosh/db` into `domain` or `forecast` compiles fine and silently destroys
the property the architecture exists for. Web/MCP/agent are adapters: they must not compute
financial results themselves, only pass them through.

### apps/web module layering

Each `apps/web/modules/<domain>/` follows the same file convention. There are no barrel files;
import the concrete file.

| File | Directive | Contract |
| --- | --- | --- |
| `queries.ts` | `import "server-only"` | Reads. Takes `userId` as an explicit parameter. Never calls `requireUser`. |
| `mutations.ts` | `"use server"` | The session-bound server action, plus a session-free `xCore(userId, input)` sibling. |
| `validators.ts` | none | Zod schemas mirroring the schema's CHECK constraints. No IO. |
| `engine.ts` / `core.ts` | `import "server-only"` | Heavy reusable logic (`rules/` only), session-free. |

The `xCore` split is the load-bearing part: **one implementation serves both the session-bound
server action and the agent/MCP path**, which has no session and passes `userId` explicitly. So a
`Core`/`engine.ts` function must never read the HTTP session or call `revalidatePath` — doing so
compiles, then breaks the agent path at runtime. `rules/core.ts` is a separate file only because
its `engine.ts` is large; other modules keep `xCore` inside `mutations.ts`.

### Auth and tenancy

Better Auth. `apps/web/lib/session.ts` exposes `requireUser()` (**redirects** to `/login`, so it is
valid only in Server Components and Server Actions) and `getApiUser()` (returns `null`, for route
handlers that need JSON). External MCP callers use neither — a bearer token is verified in
`app/api/mcp/route.ts` and `userId` comes from the token.

**There is no RLS and no scoped database client.** Every query composes its own `userId` filter
(see `baseWhere` in `modules/transactions/queries.ts`). A new query that forgets it leaks across
users and nothing catches it — not the types, not the database.

`modules/shared/ownership.ts` (`assertAccountsOwned`, `assertCategoriesOwned`, …) guards against
IDOR on any foreign id arriving from input. **Call it in every mutation that accepts one, before
writing.** It throws 404, not 403, deliberately — a 403 would confirm another tenant's record
exists. The agent tool layer does not re-check ownership; it relies on these asserts already living
inside the `xCore` functions.

### Agent / MCP surface

`modules/agent/registry.ts` holds `readTools` and `writeTools`, each Zod-typed with a `kind` and a
`risk`. `MCP_TOOLS = readTools` — **the external MCP endpoint exposes read tools only.** Scopes are
checked in three places: tool filtering (`agent.ts`), execution (`execute.ts`), and token validation
(`app/api/mcp/route.ts`).

The proposal/confirm flow (HMAC-signed `ActionProposal` + idempotency key) is fully built but
deliberately switched off: `/api/agent/prepare` and `/api/agent/confirm` always return `409
read_only`. Don't "fix" that without an explicit decision — writes stay off until durable approvals
exist.

Per PRD R6, the model may query, interpret, explain, and suggest. It never sums a balance, produces
a forecast, determines installments, or computes safe-to-spend. Tools pass input to the engine and
return its deterministic output, including `reasons`, `rejections`, and `blockers`. When there is no
recommendation, say so — inventing one is worse than reporting `NO_FEASIBLE_OPTION`.

## Invariants that nothing enforces for you

- **Money is integer minor units** plus an ISO 4217 code, never floats
  (`packages/domain/src/shared/money.ts`). The exponent is per currency (JPY 0, KWD 3, default 2).
  `formatMoney` takes an explicit locale on purpose — a hardcoded default caused a real bug
  (commit `3d1493f`). The UI never does arithmetic; it formats what the engine decided.
- **Never filter, sort, or join on an `encryptedText` column.** AES-GCM uses a random IV per write,
  so ciphertext is non-deterministic and a `WHERE` on it silently returns nothing. Affects
  `transactions.narration`/`notes`/`upiReference`/`counterpartyUpiId`/`utrNumber`, several
  `accounts` columns, and `bills.notes`. See `packages/db/src/schema/helpers.ts`.
- **The rule engine's SQL pushdown must never be narrower than the real predicate.**
  `apps/web/modules/rules/engine.ts` translates conditions into a `where` to bound the scan, but
  `matchesRule` still judges every row in memory. A condition with no SQL form (`raw_text_contains`,
  because narration is encrypted) is dropped from an `AND` and forces a full scan in an `OR`.
  `modules/rules/pushdown-db.test.ts` pins this; keep it passing when adding a condition type.
- **A transaction is a fact; a projected event is not.** They are separate entities, reconciled when
  the fact arrives (PRD R2). A card purchase is an economic expense dated at purchase; the statement
  settlement is a cash-flow event and must not create a second categorized expense (R4). A transfer
  between your own accounts has two legs and nets to zero (R5).
