"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { bills, db, transactions } from "@kosh/db";
import { advanceOnePeriod, majorToMinor, todayIso } from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import {
  assertAccountsOwned,
  assertCategoriesOwned,
} from "@/modules/shared/ownership";
import {
  createBillSchema,
  updateBillSchema,
  type CreateBillInput,
  type UpdateBillInput,
} from "./validators";

function revalidateBills() {
  revalidatePath("/plan/bills");
  revalidatePath("/overview");
}

export async function createBill(input: CreateBillInput) {
  const user = await requireUser();
  const data = createBillSchema.parse(input);
  await assertAccountsOwned(user.id, [data.accountId]);
  await assertCategoriesOwned(user.id, [data.categoryId]);

  const [bill] = await db
    .insert(bills)
    .values({
      userId: user.id,
      name: data.name,
      expectedAmountMinor: majorToMinor(data.expectedAmount, data.currencyCode),
      currencyCode: data.currencyCode,
      recurrence: data.recurrence,
      dueDay: Number(data.nextDueDate.slice(8, 10)),
      nextDueDate: data.nextDueDate,
      accountId: data.accountId ?? null,
      categoryId: data.categoryId ?? null,
      notes: data.notes,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "bill.created",
    entityType: "bill",
    entityId: bill!.id,
    data: { name: data.name },
  });
  revalidateBills();
  return bill!;
}

export async function updateBill(billId: string, input: UpdateBillInput) {
  const user = await requireUser();
  const data = updateBillSchema.parse(input);
  const existing = await db.query.bills.findFirst({
    where: and(eq(bills.id, billId), eq(bills.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Bill not found.");
  if (data.accountId !== undefined) await assertAccountsOwned(user.id, [data.accountId]);
  if (data.categoryId !== undefined) await assertCategoriesOwned(user.id, [data.categoryId]);

  const currency = data.currencyCode ?? existing.currencyCode;
  await db
    .update(bills)
    .set({
      name: data.name ?? existing.name,
      expectedAmountMinor:
        data.expectedAmount !== undefined
          ? majorToMinor(data.expectedAmount, currency)
          : existing.expectedAmountMinor,
      recurrence: data.recurrence ?? existing.recurrence,
      nextDueDate: data.nextDueDate ?? existing.nextDueDate,
      dueDay: data.nextDueDate
        ? Number(data.nextDueDate.slice(8, 10))
        : existing.dueDay,
      accountId: data.accountId === undefined ? existing.accountId : data.accountId,
      categoryId:
        data.categoryId === undefined ? existing.categoryId : data.categoryId,
      isActive: data.isActive ?? existing.isActive,
      notes: data.notes ?? existing.notes,
    })
    .where(eq(bills.id, billId));

  await logAudit({
    userId: user.id,
    action: "bill.updated",
    entityType: "bill",
    entityId: billId,
    data: { changed: Object.keys(data) },
  });
  revalidateBills();
}

/**
 * Mark the current cycle paid — optionally linking the paying transaction —
 * and advance the due date one period.
 */
export async function markBillPaid(input: {
  billId: string;
  transactionId?: string;
}) {
  const user = await requireUser();
  const bill = await db.query.bills.findFirst({
    where: and(eq(bills.id, input.billId), eq(bills.userId, user.id)),
  });
  if (!bill) throw new ApiError(404, "not_found", "Bill not found.");

  // Idempotency: re-marking paid with the same linked transaction is a no-op,
  // so a duplicate submit can't advance the due date twice.
  if (
    input.transactionId &&
    bill.lastPaidTransactionId === input.transactionId
  ) {
    return;
  }

  if (input.transactionId) {
    const tx = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.id, input.transactionId),
        eq(transactions.userId, user.id),
      ),
    });
    if (!tx) throw new ApiError(404, "not_found", "Transaction not found.");
  }

  await db.transaction(async (trx) => {
    if (input.transactionId) {
      await trx
        .update(transactions)
        .set({ billId: bill.id })
        .where(eq(transactions.id, input.transactionId));
    }
    await trx
      .update(bills)
      .set({
        lastPaidDate: todayIso(),
        lastPaidTransactionId: input.transactionId ?? null,
        nextDueDate: advanceOnePeriod(bill),
      })
      .where(eq(bills.id, bill.id));
  });

  await logAudit({
    userId: user.id,
    action: "bill.paid",
    entityType: "bill",
    entityId: bill.id,
    data: { transactionId: input.transactionId ?? null },
  });
  revalidateBills();
}

export async function deleteBill(billId: string) {
  const user = await requireUser();
  const existing = await db.query.bills.findFirst({
    where: and(eq(bills.id, billId), eq(bills.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Bill not found.");
  await db.delete(bills).where(eq(bills.id, billId));
  await logAudit({
    userId: user.id,
    action: "bill.deleted",
    entityType: "bill",
    entityId: billId,
    data: { name: existing.name },
  });
  revalidateBills();
}
