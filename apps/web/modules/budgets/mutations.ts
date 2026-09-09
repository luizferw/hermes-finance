"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { budgetCategories, budgetPeriods, budgets, db } from "@kosh/db";
import { majorToMinor, monthRange, todayIso } from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { getUserSettings } from "@/modules/settings/queries";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import { assertCategoriesOwned } from "@/modules/shared/ownership";
import {
  createBudgetSchema,
  updateBudgetSchema,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "./validators";

export async function createBudget(input: CreateBudgetInput) {
  const user = await requireUser();
  const data = createBudgetSchema.parse(input);
  await assertCategoriesOwned(user.id, data.categoryIds);
  const { start, end } = monthRange(todayIso());

  const budget = await db.transaction(async (trx) => {
    const [created] = await trx
      .insert(budgets)
      .values({ userId: user.id, name: data.name })
      .returning();

    await trx.insert(budgetCategories).values(
      data.categoryIds.map((categoryId) => ({ budgetId: created!.id, categoryId })),
    );
    await trx.insert(budgetPeriods).values({
      budgetId: created!.id,
      periodStart: start,
      periodEnd: end,
      plannedAmountMinor: majorToMinor(data.plannedAmount, data.currencyCode),
      currencyCode: data.currencyCode,
    });
    return created!;
  });

  await logAudit({
    userId: user.id,
    action: "budget.created",
    entityType: "budget",
    entityId: budget.id,
    data: { name: data.name, planned: data.plannedAmount },
  });
  revalidatePath("/plan/budgets");
  revalidatePath("/overview");
  return budget;
}

export async function updateBudget(budgetId: string, input: UpdateBudgetInput) {
  const user = await requireUser();
  const data = updateBudgetSchema.parse(input);

  const existing = await db.query.budgets.findFirst({
    where: and(eq(budgets.id, budgetId), eq(budgets.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Budget not found.");
  if (data.categoryIds) await assertCategoriesOwned(user.id, data.categoryIds);

  await db.transaction(async (trx) => {
    if (data.name) {
      await trx.update(budgets).set({ name: data.name }).where(eq(budgets.id, budgetId));
    }
    if (data.categoryIds) {
      await trx.delete(budgetCategories).where(eq(budgetCategories.budgetId, budgetId));
      await trx.insert(budgetCategories).values(
        data.categoryIds.map((categoryId) => ({ budgetId, categoryId })),
      );
    }
    if (data.plannedAmount !== undefined) {
      const { start, end } = monthRange(todayIso());
      // A budget's currency is set once at creation; editing its planned
      // amount must never silently rewrite it to a hardcoded default. Reuse
      // whatever the budget's own periods already record.
      const existingPeriod = await trx.query.budgetPeriods.findFirst({
        where: eq(budgetPeriods.budgetId, budgetId),
      });
      const currencyCode = existingPeriod?.currencyCode ?? (await getUserSettings(user.id)).currencyCode;
      const plannedAmountMinor = majorToMinor(data.plannedAmount, currencyCode);
      await trx
        .insert(budgetPeriods)
        .values({
          budgetId,
          periodStart: start,
          periodEnd: end,
          plannedAmountMinor,
          currencyCode,
        })
        .onConflictDoUpdate({
          target: [budgetPeriods.budgetId, budgetPeriods.periodStart],
          set: { plannedAmountMinor },
        });
    }
  });

  await logAudit({
    userId: user.id,
    action: "budget.updated",
    entityType: "budget",
    entityId: budgetId,
    data: { changed: Object.keys(data) },
  });
  revalidatePath("/plan/budgets");
  revalidatePath("/overview");
}

export async function archiveBudget(budgetId: string) {
  const user = await requireUser();
  const existing = await db.query.budgets.findFirst({
    where: and(eq(budgets.id, budgetId), eq(budgets.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Budget not found.");
  await db.update(budgets).set({ isArchived: true }).where(eq(budgets.id, budgetId));
  await logAudit({
    userId: user.id,
    action: "budget.archived",
    entityType: "budget",
    entityId: budgetId,
    data: { name: existing.name },
  });
  revalidatePath("/plan/budgets");
}

/**
 * Puts an archived budget back in the list.
 *
 * Archiving is this module's delete, and a delete you cannot walk back from the
 * UI is the same trap as no delete at all.
 */
export async function restoreBudget(budgetId: string) {
  const user = await requireUser();
  const existing = await db.query.budgets.findFirst({
    where: and(eq(budgets.id, budgetId), eq(budgets.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Budget not found.");
  await db.update(budgets).set({ isArchived: false }).where(eq(budgets.id, budgetId));
  await logAudit({
    userId: user.id,
    action: "budget.restored",
    entityType: "budget",
    entityId: budgetId,
    data: { name: existing.name },
  });
  revalidatePath("/plan/budgets");
}
