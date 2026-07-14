import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { agentActions, db } from "@kosh/db";
import type { ExecStatus } from "./types";

/**
 * Idempotency gate + AI-activity record. The first call for an idempotency key
 * claims it (inserts a row); a retry with the same key finds the row and is
 * told the prior outcome instead of mutating again. This is what stops a
 * network retry from creating a transaction twice.
 */
export async function claimAction(opts: {
  userId: string;
  idempotencyKey: string;
  toolName: string;
  source: "session" | "mcp";
}): Promise<{ firstTime: boolean; priorStatus?: ExecStatus | "pending" }> {
  const inserted = await db
    .insert(agentActions)
    .values({
      userId: opts.userId,
      idempotencyKey: opts.idempotencyKey,
      toolName: opts.toolName,
      source: opts.source,
      status: "pending",
    })
    .onConflictDoNothing({ target: agentActions.idempotencyKey })
    .returning({ id: agentActions.id });

  if (inserted.length > 0) return { firstTime: true };

  const [existing] = await db
    .select({ status: agentActions.status })
    .from(agentActions)
    .where(eq(agentActions.idempotencyKey, opts.idempotencyKey))
    .limit(1);
  return {
    firstTime: false,
    priorStatus: existing?.status as ExecStatus | "pending" | undefined,
  };
}

/** Finalise the claimed action with its outcome (for the activity surface). */
export async function finishAction(opts: {
  idempotencyKey: string;
  status: ExecStatus;
  summary?: Record<string, unknown>;
  entityId?: string | null;
  error?: string | null;
}): Promise<void> {
  await db
    .update(agentActions)
    .set({
      status: opts.status,
      summary: opts.summary,
      entityId: opts.entityId ?? null,
      error: opts.error ?? null,
    })
    .where(eq(agentActions.idempotencyKey, opts.idempotencyKey));
}

/** The "AI activity" feed: most recent agent actions for a user. */
export async function listAgentActivity(userId: string, limit = 50) {
  return db
    .select()
    .from(agentActions)
    .where(eq(agentActions.userId, userId))
    .orderBy(desc(agentActions.createdAt))
    .limit(limit);
}

export async function getAgentAction(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, id), eq(agentActions.userId, userId)))
    .limit(1);
  return row ?? null;
}
