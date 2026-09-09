"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, recurringTransactions } from "@kosh/db";
import { majorToMinor } from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import {
  assertAccountsOwned,
  assertCategoriesOwned,
} from "@/modules/shared/ownership";
import {
  createRecurringSchema,
  updateRecurringSchema,
  type CreateRecurringInput,
  type UpdateRecurringInput,
} from "./validators";

export async function createRecurring(input: CreateRecurringInput) {
  const user = await requireUser();
  const data = createRecurringSchema.parse(input);
  const transferAccountId =
    data.type === "transfer" ? data.transferAccountId ?? null : null;
  await assertAccountsOwned(user.id, [data.accountId, transferAccountId]);
  await assertCategoriesOwned(user.id, [data.categoryId]);
  const magnitude = majorToMinor(data.amount, data.currencyCode);

  const [recurring] = await db
    .insert(recurringTransactions)
    .values({
      userId: user.id,
      name: data.name,
      type: data.type,
      accountId: data.accountId,
      transferAccountId,
      categoryId: data.categoryId ?? null,
      amountMinor: data.type === "income" ? magnitude : -magnitude,
      currencyCode: data.currencyCode,
      description: data.description,
      interval: data.interval,
      nextRunDate: data.nextRunDate,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "recurring.created",
    entityType: "recurring_transaction",
    entityId: recurring!.id,
    data: { name: data.name, interval: data.interval },
  });
  revalidatePath("/plan/recurring");
  return recurring!;
}

/**
 * Fixes what was wrong at creation — name, type, accounts, category, amount,
 * schedule — without touching `isActive` (`setRecurringActive` owns that).
 * Preserves the create-path invariants: the sign of `amountMinor` is derived
 * from `type`, and `transferAccountId` is required for a transfer, nulled
 * otherwise.
 */
export async function updateRecurring(id: string, input: UpdateRecurringInput) {
  const user = await requireUser();
  const data = updateRecurringSchema.parse(input);
  const existing = await db.query.recurringTransactions.findFirst({
    where: and(
      eq(recurringTransactions.id, id),
      eq(recurringTransactions.userId, user.id),
    ),
  });
  if (!existing) throw new ApiError(404, "not_found", "Recurring transaction not found.");

  const type = data.type ?? existing.type;
  const transferAccountId =
    type === "transfer"
      ? data.transferAccountId === undefined
        ? existing.transferAccountId
        : data.transferAccountId
      : null;
  if (type === "transfer" && !transferAccountId) {
    throw new ApiError(400, "invalid_input", "Pick a destination account.");
  }
  const accountId = data.accountId ?? existing.accountId;
  await assertAccountsOwned(user.id, [accountId, transferAccountId]);
  if (data.categoryId !== undefined) await assertCategoriesOwned(user.id, [data.categoryId]);

  const currency = data.currencyCode ?? existing.currencyCode;
  const magnitude =
    data.amount !== undefined
      ? majorToMinor(data.amount, currency)
      : Math.abs(existing.amountMinor);

  await db
    .update(recurringTransactions)
    .set({
      name: data.name ?? existing.name,
      type,
      accountId,
      transferAccountId,
      categoryId: data.categoryId === undefined ? existing.categoryId : data.categoryId,
      amountMinor: type === "income" ? magnitude : -magnitude,
      currencyCode: currency,
      description: data.description ?? existing.description,
      interval: data.interval ?? existing.interval,
      nextRunDate: data.nextRunDate ?? existing.nextRunDate,
    })
    .where(eq(recurringTransactions.id, id));

  await logAudit({
    userId: user.id,
    action: "recurring.updated",
    entityType: "recurring_transaction",
    entityId: id,
    data: { changed: Object.keys(data) },
  });
  revalidatePath("/plan/recurring");
}

export async function setRecurringActive(id: string, isActive: boolean) {
  const user = await requireUser();
  const existing = await db.query.recurringTransactions.findFirst({
    where: and(
      eq(recurringTransactions.id, id),
      eq(recurringTransactions.userId, user.id),
    ),
  });
  if (!existing) throw new ApiError(404, "not_found", "Recurring transaction not found.");
  await db
    .update(recurringTransactions)
    .set({ isActive })
    .where(eq(recurringTransactions.id, id));
  revalidatePath("/plan/recurring");
}

export async function deleteRecurring(id: string) {
  const user = await requireUser();
  const existing = await db.query.recurringTransactions.findFirst({
    where: and(
      eq(recurringTransactions.id, id),
      eq(recurringTransactions.userId, user.id),
    ),
  });
  if (!existing) throw new ApiError(404, "not_found", "Recurring transaction not found.");
  await db.delete(recurringTransactions).where(eq(recurringTransactions.id, id));
  await logAudit({
    userId: user.id,
    action: "recurring.deleted",
    entityType: "recurring_transaction",
    entityId: id,
    data: { name: existing.name },
  });
  revalidatePath("/plan/recurring");
}
