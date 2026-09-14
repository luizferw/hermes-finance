/**
 * Drive a real sync through the app's own code path.
 *
 * Not a test — a maintenance runner that happens to need the test runner. The
 * sync module imports `server-only`, which only `vitest.config.ts` aliases away,
 * and `/api/open-finance/connections/:id/sync` is session-bound, so there is no
 * way to reach `syncConnection` from a plain script. `vitest.config.ts` already
 * anticipates this: it forces `PLUGGY_ENABLED=false` unless a run asks for the
 * real provider by name, so CI and a normal `pnpm test` can never reach a third
 * party by accident.
 *
 * It refuses to run unless both are set, which is the review:
 *
 *   VITEST_ALLOW_PLUGGY=true KOSH_RUN_REAL_SYNC=true \
 *   DATABASE_URL="postgres://kosh:...@127.0.0.1:5432/kosh" \
 *   pnpm --filter web test modules/open-finance/maintenance-sync.test.ts
 *
 * This writes to real financial data. Take a backup first — `docker compose up`
 * does, through the `migrate` service.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, openFinanceConnections, openFinanceSyncRuns } from "@kosh/db";
import { syncConnection } from "./sync";

const ARMED =
  process.env.KOSH_RUN_REAL_SYNC === "true" && process.env.VITEST_ALLOW_PLUGGY === "true";

describe.skipIf(!ARMED)("maintenance: sync every connection", () => {
  it("runs", async () => {
    const connections = await db
      .select({
        id: openFinanceConnections.id,
        userId: openFinanceConnections.userId,
        label: openFinanceConnections.label,
        connectorName: openFinanceConnections.connectorName,
      })
      .from(openFinanceConnections);
    expect(connections.length).toBeGreaterThan(0);

    for (const connection of connections) {
      const name = connection.label ?? connection.connectorName ?? connection.id;
      const summary = await syncConnection(connection.userId, connection.id, {
        trigger: "manual",
      });
      const [run] = summary.runId
        ? await db
            .select({ stats: openFinanceSyncRuns.stats })
            .from(openFinanceSyncRuns)
            .where(eq(openFinanceSyncRuns.id, summary.runId))
        : [];

      console.log(
        `${name}: ${summary.status} — seen=${summary.counts.seen} created=${summary.counts.created} ` +
          `updated=${summary.counts.updated} needsReview=${summary.counts.needsReview}` +
          (summary.message ? ` — ${summary.message}` : ""),
      );
      if (run?.stats.selfTransfersPaired) {
        console.log(`  self-transfers paired: ${run.stats.selfTransfersPaired}`);
      }
      if (run?.stats.cardPaymentsPaired) {
        console.log(`  card payments paired: ${run.stats.cardPaymentsPaired}`);
      }
      if (run?.stats.failedAccounts?.length) {
        console.log(`  failed accounts: ${JSON.stringify(run.stats.failedAccounts)}`);
      }
    }
  }, 600_000);
});
