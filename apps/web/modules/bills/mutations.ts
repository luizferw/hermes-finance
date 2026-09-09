"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { bills, db, transactions, transactionSplits } from "@kosh/db";
import {
  advanceOnePeriod,
  computeImportHash,
  majorToMinor,
  todayIso,
} from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import {
  assertAccountsOwned,
  assertCategoriesOwned,
} from "@/modules/shared/ownership";
import { recomputeAccountBalances } from "@/modules/accounts/queries";
import { listUnlinkedExpenseCandidates } from "@/modules/transactions/queries";
import {
  createBillSchema,
  markBillPaidSchema,
  updateBillSchema,
  type CreateBillInput,
  type MarkBillPaidInput,
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
      amountStrategy: data.amountStrategy,
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
      amountStrategy: data.amountStrategy ?? existing.amountStrategy,
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
 * Mark the current cycle paid and advance the due date one period. Three
 * shapes of input, mutually exclusive (enforced by the schema):
 *  - `transactionId` — link an existing transaction; its amount is already a
 *    fact on that row.
 *  - `amount` (+ optional `paymentDate`) — for a variable bill where no
 *    matching transaction exists yet: create the expense that records what
 *    was actually paid, so the next forecast (PRD §9.10) reads real history
 *    instead of the typed estimate.
 *  - neither — today's plain one-click case, unchanged (fixed bills).
 */
export async function markBillPaid(input: MarkBillPaidInput) {
  const user = await requireUser();
  const data = markBillPaidSchema.parse(input);
  const bill = await db.query.bills.findFirst({
    where: and(eq(bills.id, data.billId), eq(bills.userId, user.id)),
  });
  if (!bill) throw new ApiError(404, "not_found", "Bill not found.");

  // Idempotency: re-marking paid with the same linked transaction is a no-op,
  // so a duplicate submit can't advance the due date twice.
  if (data.transactionId && bill.lastPaidTransactionId === data.transactionId) {
    return;
  }

  if (data.transactionId) {
    const tx = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.id, data.transactionId),
        eq(transactions.userId, user.id),
      ),
    });
    if (!tx) throw new ApiError(404, "not_found", "Transaction not found.");
  }

  if (data.amount !== undefined && !bill.accountId) {
    throw new ApiError(
      422,
      "missing_account",
      "This bill has no account, so a payment transaction can't be recorded for it.",
    );
  }

  let createdTransactionId: string | null = null;

  await db.transaction(async (trx) => {
    if (data.transactionId) {
      await trx
        .update(transactions)
        .set({ billId: bill.id })
        .where(eq(transactions.id, data.transactionId));
    } else if (data.amount !== undefined) {
      const accountId = bill.accountId!;
      const date = data.paymentDate ?? todayIso();
      const amountMinor = -majorToMinor(data.amount, bill.currencyCode);

      const [created] = await trx
        .insert(transactions)
        .values({
          userId: user.id,
          accountId,
          type: "expense",
          date,
          amountMinor,
          currencyCode: bill.currencyCode,
          description: bill.name,
          categoryId: bill.categoryId,
          billId: bill.id,
          importHash: computeImportHash({
            accountId,
            date,
            amountMinor,
            description: bill.name,
          }),
        })
        .returning();
      createdTransactionId = created!.id;

      await trx.insert(transactionSplits).values({
        transactionId: created!.id,
        categoryId: bill.categoryId,
        amountMinor,
        sortOrder: 0,
      });

      await recomputeAccountBalances([accountId], trx);
    }

    await trx
      .update(bills)
      .set({
        // When the user says the payment happened on another day, that day is
        // when the bill was paid — not the day they got around to recording it.
        lastPaidDate: data.paymentDate ?? todayIso(),
        lastPaidTransactionId: data.transactionId ?? createdTransactionId,
        nextDueDate: advanceOnePeriod(bill),
      })
      .where(eq(bills.id, bill.id));
  });

  await logAudit({
    userId: user.id,
    action: "bill.paid",
    entityType: "bill",
    entityId: bill.id,
    data: {
      transactionId: data.transactionId ?? createdTransactionId,
      createdTransaction: createdTransactionId !== null,
    },
  });
  revalidateBills();
}

/** Candidate transactions the "mark paid" dialog can offer to link instead of
 * typing an amount — unlinked expenses on the bill's account. Session-bound
 * wrapper around the `server-only` query so a client component can call it. */
export async function listBillPaymentCandidates(billId: string, limit = 15) {
  const user = await requireUser();
  const bill = await db.query.bills.findFirst({
    where: and(eq(bills.id, billId), eq(bills.userId, user.id)),
  });
  if (!bill) throw new ApiError(404, "not_found", "Bill not found.");
  return listUnlinkedExpenseCandidates(user.id, bill.accountId, limit);
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
