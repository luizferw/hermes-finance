import "server-only";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  isNotNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db, transactions } from "@kosh/db";
import { majorToMinor } from "@kosh/domain";
import type { ListTransactionsInput } from "./validators";

function baseWhere(userId: string): SQL {
  return and(eq(transactions.userId, userId), isNull(transactions.deletedAt))!;
}

/**
 * Recent, unlinked expenses on one account — candidates for "this is the
 * transaction that actually paid this bill". Already-linked transactions
 * are excluded so the same payment can't be attached to two bills.
 */
export async function listUnlinkedExpenseCandidates(userId: string, accountId: string | null, limit = 15) {
  return db.query.transactions.findMany({
    where: and(
      baseWhere(userId),
      accountId ? eq(transactions.accountId, accountId) : undefined,
      eq(transactions.type, "expense"),
      isNull(transactions.billId),
    ),
    orderBy: [desc(transactions.date), desc(transactions.createdAt)],
    limit,
    columns: { id: true, date: true, amountMinor: true, description: true, merchant: true },
  });
}

export async function getInboxCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(transactions)
    .where(
      and(
        baseWhere(userId),
        inArray(transactions.status, ["pending", "imported"]),
      ),
    );
  return row?.value ?? 0;
}

export type TransactionWithRelations = Awaited<
  ReturnType<typeof listTransactions>
>["items"][number];

export async function listTransactions(
  userId: string,
  input: ListTransactionsInput,
) {
  const conditions: (SQL | undefined)[] = [baseWhere(userId)];
  if (input.q) {
    const like = `%${input.q}%`;
    // notes is encrypted at rest (non-deterministic ciphertext), so it can't be
    // matched with ILIKE. Search the cleartext-indexed fields instead.
    conditions.push(
      or(
        ilike(transactions.description, like),
        ilike(transactions.merchant, like),
        ilike(transactions.rawDescription, like),
      ),
    );
  }
  if (input.accountId) {
    conditions.push(
      or(
        eq(transactions.accountId, input.accountId),
        eq(transactions.transferAccountId, input.accountId),
      ),
    );
  }
  if (input.categoryId) conditions.push(eq(transactions.categoryId, input.categoryId));
  if (input.status) conditions.push(eq(transactions.status, input.status));
  if (input.type) conditions.push(eq(transactions.type, input.type));
  if (input.from) conditions.push(gte(transactions.date, input.from));
  if (input.to) conditions.push(lte(transactions.date, input.to));
  if (input.minAmount !== undefined) {
    conditions.push(
      gte(
        sql`ABS(${transactions.amountMinor})`,
        majorToMinor(input.minAmount, "INR"),
      ),
    );
  }
  if (input.maxAmount !== undefined) {
    conditions.push(
      lte(
        sql`ABS(${transactions.amountMinor})`,
        majorToMinor(input.maxAmount, "INR"),
      ),
    );
  }

  const where = and(...conditions);
  const [items, totalRow] = await Promise.all([
    db.query.transactions.findMany({
      where,
      with: {
        account: { columns: { id: true, name: true, type: true } },
        transferAccount: { columns: { id: true, name: true } },
        category: { columns: { id: true, name: true, icon: true, color: true } },
        transactionTags: { with: { tag: true } },
      },
      orderBy: [desc(transactions.date), desc(transactions.createdAt)],
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    }),
    db.select({ value: count() }).from(transactions).where(where),
  ]);

  return {
    items,
    total: totalRow[0]?.value ?? 0,
    page: input.page,
    pageSize: input.pageSize,
  };
}

export async function getTransaction(userId: string, id: string) {
  return db.query.transactions.findFirst({
    where: and(eq(transactions.id, id), baseWhere(userId)),
    with: {
      account: true,
      transferAccount: true,
      category: true,
      bill: true,
      importFile: true,
      recurringTransaction: true,
      suspectedDuplicateOf: true,
      splits: { with: { category: true } },
      transactionTags: { with: { tag: true } },
      metadata: true,
    },
  });
}

/** Inbox: everything imported or pending review, with duplicate context. */
export async function getInboxItems(userId: string) {
  return db.query.transactions.findMany({
    where: and(
      baseWhere(userId),
      inArray(transactions.status, ["pending", "imported"]),
    ),
    with: {
      account: { columns: { id: true, name: true, type: true } },
      category: { columns: { id: true, name: true, icon: true, color: true } },
      suspectedDuplicateOf: {
        columns: { id: true, description: true, date: true, amountMinor: true, status: true },
      },
      importFile: { columns: { id: true, fileName: true } },
    },
    orderBy: [desc(transactions.date), desc(transactions.createdAt)],
    limit: 200,
  });
}

/** Recently rejected items, for the inbox "rejected" tab. */
export async function getRecentlyRejected(userId: string, limit = 50) {
  return db.query.transactions.findMany({
    where: and(baseWhere(userId), eq(transactions.status, "rejected")),
    with: {
      account: { columns: { id: true, name: true, type: true } },
      category: { columns: { id: true, name: true, icon: true, color: true } },
    },
    orderBy: [desc(transactions.updatedAt)],
    limit,
  });
}

export async function getRecentTransactions(userId: string, limit = 8) {
  return db.query.transactions.findMany({
    where: and(
      baseWhere(userId),
      inArray(transactions.status, ["imported", "reviewed", "posted"]),
    ),
    with: {
      account: { columns: { id: true, name: true } },
      category: { columns: { id: true, name: true, icon: true, color: true } },
    },
    orderBy: [desc(transactions.date), desc(transactions.createdAt)],
    limit,
  });
}

/** Count of uncategorized, review-needing transactions (rule suggestions input). */
export async function getUncategorizedInboxCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(transactions)
    .where(
      and(
        baseWhere(userId),
        inArray(transactions.status, ["pending", "imported"]),
        isNull(transactions.categoryId),
      ),
    );
  return row?.value ?? 0;
}

/**
 * Merchant memory: the category + account last used for a merchant, so
 * quick-add can prefill them. Case-insensitive exact match on the merchant
 * label, most recent transaction wins. Returns null when unseen.
 *
 * exact-label match only. Fuzzy ("PAYTM*SWIGGY" ~ "Swiggy") is a
 * normalization problem for the import layer; add when messy labels reach here.
 */
export async function recallMerchant(
  userId: string,
  merchant: string,
): Promise<{ categoryId: string | null; accountId: string } | null> {
  const name = merchant.trim();
  if (!name) return null;
  const [row] = await db
    .select({
      categoryId: transactions.categoryId,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(
      and(
        baseWhere(userId),
        sql`lower(${transactions.merchant}) = lower(${name})`,
      ),
    )
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getDuplicateSuspectCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(transactions)
    .where(
      and(
        baseWhere(userId),
        inArray(transactions.status, ["pending", "imported"]),
        isNotNull(transactions.suspectedDuplicateOfId),
      ),
    );
  return row?.value ?? 0;
}
