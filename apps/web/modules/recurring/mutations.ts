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
import { createRecurringSchema, type CreateRecurringInput } from "./validators";

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
