"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, savingsGoals } from "@kosh/db";
import { majorToMinor, todayIso } from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import { assertAccountsOwned } from "@/modules/shared/ownership";
import { createGoalSchema, type CreateGoalInput } from "./validators";

/** Core goal creation, tenancy-scoped by explicit userId. Shared by the server
 * action, the agent, and the MCP server. */
export async function createGoalCore(userId: string, input: CreateGoalInput) {
  const data = createGoalSchema.parse(input);
  await assertAccountsOwned(userId, [data.accountId]);
  const [goal] = await db
    .insert(savingsGoals)
    .values({
      userId,
      name: data.name,
      targetAmountMinor: majorToMinor(data.targetAmount, data.currencyCode),
      currentAmountMinor: majorToMinor(data.currentAmount, data.currencyCode),
      currencyCode: data.currencyCode,
      accountId: data.accountId ?? null,
      targetDate: data.targetDate ?? null,
    })
    .returning();
  await logAudit({
    userId,
    action: "goal.created",
    entityType: "savings_goal",
    entityId: goal!.id,
    data: { name: data.name },
  });
  return goal!;
}

export async function createGoal(input: CreateGoalInput) {
  const user = await requireUser();
  const goal = await createGoalCore(user.id, input);
  revalidatePath("/plan/goals");
  return goal;
}

/** Add or remove money (major units; negative withdraws). */
export async function contributeToGoal(goalId: string, amount: number) {
  const user = await requireUser();
  const parsed = z.coerce.number().refine((n) => n !== 0).parse(amount);
  const goal = await db.query.savingsGoals.findFirst({
    where: and(eq(savingsGoals.id, goalId), eq(savingsGoals.userId, user.id)),
  });
  if (!goal) throw new ApiError(404, "not_found", "Goal not found.");

  const delta = majorToMinor(parsed, goal.currencyCode);
  const next = Math.max(0, goal.currentAmountMinor + delta);
  await db
    .update(savingsGoals)
    .set({
      currentAmountMinor: next,
      achievedAt:
        next >= goal.targetAmountMinor ? (goal.achievedAt ?? todayIso()) : null,
    })
    .where(eq(savingsGoals.id, goalId));

  await logAudit({
    userId: user.id,
    action: "goal.contributed",
    entityType: "savings_goal",
    entityId: goalId,
    data: { deltaMinor: delta },
  });
  revalidatePath("/plan/goals");
}

export async function deleteGoal(goalId: string) {
  const user = await requireUser();
  const goal = await db.query.savingsGoals.findFirst({
    where: and(eq(savingsGoals.id, goalId), eq(savingsGoals.userId, user.id)),
  });
  if (!goal) throw new ApiError(404, "not_found", "Goal not found.");
  await db.delete(savingsGoals).where(eq(savingsGoals.id, goalId));
  await logAudit({
    userId: user.id,
    action: "goal.deleted",
    entityType: "savings_goal",
    entityId: goalId,
    data: { name: goal.name },
  });
  revalidatePath("/plan/goals");
}
