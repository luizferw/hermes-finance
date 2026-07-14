import "server-only";

import { and, eq, lte, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { bills, db, systemJobs } from "@kosh/db";
import { todayIso } from "@kosh/domain";
import { env } from "@/lib/env";
import { ensureCurrentBudgetPeriods } from "@/modules/budgets/jobs";
import { generateDueRecurringTransactions } from "@/modules/recurring/jobs";

interface JobDefinition {
  name: string;
  description: string;
  schedule: string;
  run: () => Promise<unknown>;
}

const JOBS: JobDefinition[] = [
  {
    name: "recurring-transactions",
    description: "Generates pending transaction drafts from recurring templates",
    schedule: "0 6 * * *",
    run: generateDueRecurringTransactions,
  },
  {
    name: "budget-periods",
    description: "Copies active budget amounts into the current month",
    schedule: "15 0 1 * *",
    run: ensureCurrentBudgetPeriods,
  },
  {
    name: "bill-status-check",
    description: "Checks active bill due dates for operator health reporting",
    schedule: "0 7 * * *",
    run: countDueBills,
  },
  {
    name: "health-check",
    description: "Records app/database health for the self-hosting screen",
    schedule: "*/30 * * * *",
    run: async () => db.execute(sql`SELECT 1`),
  },
];

const globalForJobs = globalThis as typeof globalThis & {
  koshJobsPromise?: Promise<PgBoss | null>;
};

export function startJobs() {
  if (globalForJobs.koshJobsPromise) return globalForJobs.koshJobsPromise;
  globalForJobs.koshJobsPromise = startJobsOnce();
  return globalForJobs.koshJobsPromise;
}

async function startJobsOnce(): Promise<PgBoss | null> {
  const config = env();
  if (config.KOSH_DISABLE_JOBS) {
    return null;
  }

  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    application_name: "kosh-jobs",
    max: 2,
  });

  boss.on("error", (err) => {
    console.error("[kosh jobs]", err instanceof Error ? err.name : "unknown");
  });

  await boss.start();

  for (const job of JOBS) {
    await registerJob(job);
    await boss.createQueue(job.name, {
      retryLimit: 2,
      retryDelay: 60,
      retentionSeconds: 60 * 60 * 24 * 14,
      deleteAfterSeconds: 60 * 60 * 24 * 7,
    });
    await boss.schedule(job.name, job.schedule, {}, { tz: "UTC" });
    await boss.work(job.name, { localConcurrency: 1 }, async (jobs) => {
      for (let index = 0; index < jobs.length; index += 1) {
        await runTracked(job);
      }
    });
  }

  return boss;
}

async function registerJob(job: JobDefinition) {
  await db
    .insert(systemJobs)
    .values({
      name: job.name,
      description: job.description,
      schedule: job.schedule,
    })
    .onConflictDoUpdate({
      target: [systemJobs.name],
      set: {
        description: job.description,
        schedule: job.schedule,
        updatedAt: new Date(),
      },
    });
}

async function runTracked(job: JobDefinition) {
  const startedAt = new Date();
  try {
    await job.run();
    await recordJobResult(job, startedAt, "ok", null);
  } catch (err) {
    await recordJobResult(job, startedAt, "error", errorMessage(err));
    throw err;
  }
}

async function recordJobResult(
  job: JobDefinition,
  startedAt: Date,
  status: "ok" | "error",
  error: string | null,
) {
  await db
    .insert(systemJobs)
    .values({
      name: job.name,
      description: job.description,
      schedule: job.schedule,
      lastRunAt: startedAt,
      lastStatus: status,
      lastError: error,
      lastDurationMs: Date.now() - startedAt.getTime(),
    })
    .onConflictDoUpdate({
      target: [systemJobs.name],
      set: {
        description: job.description,
        schedule: job.schedule,
        lastRunAt: startedAt,
        lastStatus: status,
        lastError: error,
        lastDurationMs: Date.now() - startedAt.getTime(),
        updatedAt: new Date(),
      },
    });
}

async function countDueBills() {
  return db.query.bills.findMany({
    where: and(eq(bills.isActive, true), lte(bills.nextDueDate, todayIso())),
    columns: { id: true },
  });
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.name : "Job failed";
}
