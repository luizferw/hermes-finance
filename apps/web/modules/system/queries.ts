import "server-only";
import { accessSync, constants, mkdirSync } from "node:fs";
import { asc, sql } from "drizzle-orm";
import { db, systemJobs } from "@kosh/db";
import { env } from "@/lib/env";
import packageJson from "../../package.json";

export type CheckStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface SystemHealth {
  checks: HealthCheck[];
  jobs: Array<typeof systemJobs.$inferSelect>;
  version: string;
  environment: string;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const checks: HealthCheck[] = [];

  // Database connectivity + server version.
  let postgresVersion = "unreachable";
  try {
    const result = await db.execute(sql`SELECT version()`);
    const raw = String(
      (result.rows[0] as Record<string, unknown>)?.version ?? "",
    );
    postgresVersion = raw.split(" on ")[0] ?? raw;
    checks.push({
      id: "database",
      label: "Database connection",
      status: "ok",
      detail: postgresVersion,
    });
  } catch (err) {
    checks.push({
      id: "database",
      label: "Database connection",
      status: "error",
      detail: err instanceof Error ? err.message : "Connection failed",
    });
  }

  // Migrations applied (drizzle keeps a journal table).
  try {
    const result = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations`,
    );
    const count = Number((result.rows[0] as Record<string, unknown>)?.count ?? 0);
    checks.push({
      id: "migrations",
      label: "Migrations",
      status: count > 0 ? "ok" : "warn",
      detail:
        count > 0
          ? `${count} migration${count === 1 ? "" : "s"} applied`
          : "No migrations applied yet — run pnpm db:migrate",
    });
  } catch {
    checks.push({
      id: "migrations",
      label: "Migrations",
      status: "warn",
      detail: "Migration journal not found — run pnpm db:migrate",
    });
  }

  // App URL configured.
  const appUrl = env().APP_URL;
  checks.push({
    id: "app-url",
    label: "App URL",
    status: appUrl.startsWith("http") ? "ok" : "warn",
    detail: appUrl,
  });

  // File storage writable.
  const storageDir = env().KOSH_STORAGE_DIR ?? `${process.cwd()}/data/storage`;
  try {
    mkdirSync(storageDir, { recursive: true });
    accessSync(storageDir, constants.W_OK);
    checks.push({
      id: "storage",
      label: "File storage",
      status: "ok",
      detail: `${storageDir} is writable`,
    });
  } catch {
    checks.push({
      id: "storage",
      label: "File storage",
      status: "warn",
      detail: `${storageDir} is not writable`,
    });
  }

  // Background jobs.
  let jobs: Array<typeof systemJobs.$inferSelect> = [];
  try {
    jobs = await db.query.systemJobs.findMany({ orderBy: [asc(systemJobs.name)] });
    const disabled = env().KOSH_DISABLE_JOBS;
    const stale = jobs.filter(
      (job) =>
        job.lastRunAt &&
        Date.now() - job.lastRunAt.getTime() > 1000 * 60 * 60 * 36,
    );
    const failing = jobs.filter((job) => job.lastStatus === "error");
    checks.push({
      id: "jobs",
      label: "Background jobs",
      status: disabled
        ? "warn"
        : failing.length > 0
          ? "error"
          : jobs.length === 0 || stale.length > 0
            ? "warn"
            : "ok",
      detail: disabled
        ? "Disabled via KOSH_DISABLE_JOBS"
        : failing.length > 0
          ? `${failing.map((j) => j.name).join(", ")} failing`
          : jobs.length === 0
            ? "No jobs registered yet — they register on first app start"
            : stale.length > 0
              ? `${stale.map((j) => j.name).join(", ")} stale (>36h)`
              : `${jobs.length} jobs healthy`,
    });
  } catch {
    checks.push({
      id: "jobs",
      label: "Background jobs",
      status: "warn",
      detail: "Could not read job status",
    });
  }

  // Auth secret sanity.
  checks.push({
    id: "auth-secret",
    label: "Auth secret",
    status:
      env().BETTER_AUTH_SECRET === "change-me-to-a-long-random-string"
        ? "error"
        : "ok",
    detail:
      env().BETTER_AUTH_SECRET === "change-me-to-a-long-random-string"
        ? "Still the placeholder — set BETTER_AUTH_SECRET"
        : "Configured",
  });

  // Privacy posture is structural; surface it so operators can verify.
  checks.push({
    id: "telemetry",
    label: "Telemetry",
    status: "ok",
    detail: "No analytics, no external calls, no tracking — by design",
  });

  return {
    checks,
    jobs,
    version: packageJson.version ?? "0.0.0",
    environment: env().NODE_ENV,
  };
}
