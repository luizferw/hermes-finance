"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  db,
  transactionSplits,
  transactionTags,
  transactions,
} from "@kosh/db";
import { computeImportHash, majorToMinor } from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import {
  assertCategoriesOwned,
  assertTagsOwned,
} from "@/modules/shared/ownership";
import { recomputeAccountBalances } from "@/modules/accounts/queries";
import {
  bulkIdsSchema,
  createTransactionSchema,
  updateTransactionSchema,
  type CreateTransactionInput,
  type UpdateTransactionInput,
} from "./validators";
import { recallMerchant } from "./queries";

/** Last category + account used for a merchant, for quick-add prefill. */
export async function recallMerchantMemory(merchant: string) {
  const user = await requireUser();
  return recallMerchant(user.id, merchant);
}

function revalidateLedger() {
  revalidatePath("/overview");
  revalidatePath("/inbox");
  revalidatePath("/transactions");
  revalidatePath("/accounts");
}

async function ownedTransactions(userId: string, ids: string[]) {
  return db.query.transactions.findMany({
    where: and(
      inArray(transactions.id, ids),
      eq(transactions.userId, userId),
      isNull(transactions.deletedAt),
    ),
  });
}

function affectedAccounts(
  rows: Array<{ accountId: string; transferAccountId: string | null }>,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.accountId);
    if (row.transferAccountId) ids.add(row.transferAccountId);
  }
  return [...ids];
}

/**
 * Core create logic, tenancy-scoped by an explicit `userId`. No session lookup
 * and no path revalidation, so it is callable from any authenticated context —
 * the ordinary server action below, the agent, and the MCP server all share
 * this one implementation (single source of financial truth).
 */
export async function createTransactionCore(
  userId: string,
  input: CreateTransactionInput,
) {
  const data = createTransactionSchema.parse(input);

  const account = await db.query.accounts.findFirst({
    where: (a, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(a.id, data.accountId), eqOp(a.userId, userId)),
  });
  if (!account) throw new ApiError(404, "not_found", "Account not found.");

  const transferAccountId =
    data.type === "transfer" ? data.transferAccountId ?? null : null;
  if (transferAccountId) {
    const destination = await db.query.accounts.findFirst({
      where: (a, { and: andOp, eq: eqOp }) =>
        andOp(eqOp(a.id, transferAccountId), eqOp(a.userId, userId)),
    });
    if (!destination) {
      throw new ApiError(404, "not_found", "Account not found.");
    }
    if (destination.currencyCode !== account.currencyCode) {
      throw new ApiError(
        422,
        "currency_mismatch",
        "Transfers between accounts in different currencies are not supported.",
      );
    }
  }
  await assertCategoriesOwned(userId, [data.categoryId]);
  await assertTagsOwned(userId, data.tagIds ?? []);

  const magnitude = majorToMinor(data.amount, account.currencyCode);
  const amountMinor = data.type === "income" ? magnitude : -magnitude;

  const tx = await db.transaction(async (trx) => {
    const [created] = await trx
      .insert(transactions)
      .values({
        userId,
        accountId: data.accountId,
        transferAccountId,
        type: data.type,
        status: data.status ?? "posted",
        date: data.date,
        amountMinor,
        currencyCode: account.currencyCode,
        description: data.description,
        merchant: data.merchant ?? null,
        categoryId: data.categoryId ?? null,
        notes: data.notes ?? null,
        importHash: computeImportHash({
          accountId: data.accountId,
          date: data.date,
          amountMinor,
          description: data.description,
        }),
      })
      .returning();

    await trx.insert(transactionSplits).values({
      transactionId: created!.id,
      categoryId: data.categoryId ?? null,
      amountMinor,
      sortOrder: 0,
    });
    if (data.tagIds?.length) {
      await trx.insert(transactionTags).values(
        data.tagIds.map((tagId) => ({ transactionId: created!.id, tagId })),
      );
    }
    await recomputeAccountBalances(affectedAccounts([created!]), trx);
    return created!;
  });

  await logAudit({
    userId,
    action: "transaction.created",
    entityType: "transaction",
    entityId: tx.id,
    data: { description: data.description, amountMinor, type: data.type },
  });
  return tx;
}

export async function createTransaction(input: CreateTransactionInput) {
  const user = await requireUser();
  const tx = await createTransactionCore(user.id, input);
  revalidateLedger();
  return tx;
}

export async function updateTransactionCore(
  userId: string,
  id: string,
  input: UpdateTransactionInput,
) {
  const data = updateTransactionSchema.parse(input);

  const [existing] = await ownedTransactions(userId, [id]);
  if (!existing) throw new ApiError(404, "not_found", "Transaction not found.");

  if (data.categoryId !== undefined) await assertCategoriesOwned(userId, [data.categoryId]);
  if (data.tagIds !== undefined) await assertTagsOwned(userId, data.tagIds);

  await db.transaction(async (trx) => {
    await trx
      .update(transactions)
      .set({
        date: data.date ?? existing.date,
        description: data.description ?? existing.description,
        merchant: data.merchant === undefined ? existing.merchant : data.merchant,
        categoryId:
          data.categoryId === undefined ? existing.categoryId : data.categoryId,
        notes: data.notes === undefined ? existing.notes : data.notes,
        status: data.status ?? existing.status,
      })
      .where(eq(transactions.id, id));

    // Keep the single-split case mirrored with the parent.
    if (data.categoryId !== undefined) {
      const splits = await trx.query.transactionSplits.findMany({
        where: eq(transactionSplits.transactionId, id),
      });
      if (splits.length === 1) {
        await trx
          .update(transactionSplits)
          .set({ categoryId: data.categoryId })
          .where(eq(transactionSplits.id, splits[0]!.id));
      }
    }

    if (data.tagIds !== undefined) {
      await trx.delete(transactionTags).where(eq(transactionTags.transactionId, id));
      if (data.tagIds.length > 0) {
        await trx.insert(transactionTags).values(
          data.tagIds.map((tagId) => ({ transactionId: id, tagId })),
        );
      }
    }
  });

  if (data.status && data.status !== existing.status) {
    await recomputeAccountBalances(affectedAccounts([existing]));
  }

  await logAudit({
    userId,
    action: "transaction.updated",
    entityType: "transaction",
    entityId: id,
    data: { changed: Object.keys(data) },
  });
}

export async function updateTransaction(
  id: string,
  input: UpdateTransactionInput,
) {
  const user = await requireUser();
  await updateTransactionCore(user.id, id, input);
  revalidateLedger();
}

/** Inbox approve: imported/pending/reviewed → posted. */
export async function approveTransactionsCore(
  userId: string,
  input: { ids: string[] },
) {
  const { ids } = bulkIdsSchema.parse(input);
  const rows = await ownedTransactions(userId, ids);
  const eligible = rows.filter((r) =>
    ["imported", "pending", "reviewed"].includes(r.status),
  );
  if (eligible.length === 0) return { approved: 0 };

  await db.transaction(async (trx) => {
    await trx
      .update(transactions)
      .set({ status: "posted", suspectedDuplicateOfId: null })
      .where(inArray(transactions.id, eligible.map((r) => r.id)));
    await recomputeAccountBalances(affectedAccounts(eligible), trx);
  });
  await logAudit({
    userId,
    action: "transaction.approved",
    entityType: "transaction",
    data: { count: eligible.length, ids: eligible.map((r) => r.id) },
  });
  return { approved: eligible.length };
}

export async function approveTransactions(input: { ids: string[] }) {
  const user = await requireUser();
  const result = await approveTransactionsCore(user.id, input);
  revalidateLedger();
  return result;
}

/** Inbox reject: excluded from the ledger but kept for provenance. */
export async function rejectTransactions(input: { ids: string[] }) {
  const user = await requireUser();
  const { ids } = bulkIdsSchema.parse(input);
  const rows = await ownedTransactions(user.id, ids);
  if (rows.length === 0) return { rejected: 0 };

  await db
    .update(transactions)
    .set({ status: "rejected" })
    .where(inArray(transactions.id, rows.map((r) => r.id)));

  await recomputeAccountBalances(affectedAccounts(rows));
  await logAudit({
    userId: user.id,
    action: "transaction.rejected",
    entityType: "transaction",
    data: { count: rows.length, ids: rows.map((r) => r.id) },
  });
  revalidateLedger();
  return { rejected: rows.length };
}

/** Restore a rejected transaction back into the inbox. */
export async function restoreTransactions(input: { ids: string[] }) {
  const user = await requireUser();
  const { ids } = bulkIdsSchema.parse(input);
  const rows = await ownedTransactions(user.id, ids);
  const eligible = rows.filter((r) => r.status === "rejected");
  if (eligible.length === 0) return { restored: 0 };

  await db
    .update(transactions)
    .set({ status: "imported" })
    .where(inArray(transactions.id, eligible.map((r) => r.id)));

  await recomputeAccountBalances(affectedAccounts(eligible));
  revalidateLedger();
  return { restored: eligible.length };
}

export async function bulkCategorizeCore(
  userId: string,
  input: { ids: string[]; categoryId: string },
) {
  const { ids } = bulkIdsSchema.parse({ ids: input.ids });
  await assertCategoriesOwned(userId, [input.categoryId]);
  const rows = await ownedTransactions(userId, ids);
  if (rows.length === 0) return { updated: 0 };
  const rowIds = rows.map((r) => r.id);

  await db.transaction(async (trx) => {
    await trx
      .update(transactions)
      .set({ categoryId: input.categoryId })
      .where(inArray(transactions.id, rowIds));
    // Mirror the category onto single-split rows so split-level reports agree.
    await trx.execute(sql`
      UPDATE ${transactionSplits} s
      SET category_id = ${input.categoryId}
      WHERE s.transaction_id = ANY(${sql.param(rowIds)}::uuid[])
        AND (SELECT COUNT(*) FROM ${transactionSplits} s2 WHERE s2.transaction_id = s.transaction_id) = 1
    `);
  });

  await logAudit({
    userId,
    action: "transaction.bulk_categorized",
    entityType: "transaction",
    data: { count: rows.length, categoryId: input.categoryId },
  });
  return { updated: rows.length };
}

export async function bulkCategorize(input: { ids: string[]; categoryId: string }) {
  const user = await requireUser();
  const result = await bulkCategorizeCore(user.id, input);
  revalidateLedger();
  return result;
}

/** Soft delete. */
export async function deleteTransaction(id: string) {
  const user = await requireUser();
  const [existing] = await ownedTransactions(user.id, [id]);
  if (!existing) throw new ApiError(404, "not_found", "Transaction not found.");

  await db
    .update(transactions)
    .set({ deletedAt: new Date() })
    .where(eq(transactions.id, id));

  await recomputeAccountBalances(affectedAccounts([existing]));
  await logAudit({
    userId: user.id,
    action: "transaction.deleted",
    entityType: "transaction",
    entityId: id,
    data: { description: existing.description },
  });
  revalidateLedger();
}
