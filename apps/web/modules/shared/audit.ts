import "server-only";
import { auditLogs, db } from "@kosh/db";

const SAFE_KEYS = new Set([
  "id",
  "ids",
  "count",
  "rows",
  "created",
  "updated",
  "deleted",
  "approved",
  "rejected",
  "restored",
  "rulesApplied",
  "changed",
  "source",
  "status",
  "trigger",
  "matched",
  "applied",
  "scopes",
]);

function safeAuditData(data: Record<string, unknown> | undefined) {
  if (!data) return undefined;
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => SAFE_KEYS.has(key)),
  );
}

/**
 * Append-only audit trail. Called by every mutating module function.
 * Failures are logged but never break the user action.
 */
export async function logAudit(entry: {
  userId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      data: safeAuditData(entry.data),
    });
  } catch (err) {
    console.error(
      `audit log failed for ${entry.action}:`,
      err instanceof Error ? err.name : "unknown",
    );
  }
}
