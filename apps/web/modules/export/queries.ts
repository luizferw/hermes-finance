import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  transactions,
  accounts,
  categories,
  tags,
  budgets,
  bills,
  recurringTransactions,
  savingsGoals,
  userSettings,
  transactionSplits,
} from "@kosh/db";
import { minorToMajor } from "@kosh/domain";

export interface TransactionExportRow {
  date: string;
  type: string;
  status: string;
  account: string;
  transferAccount: string;
  category: string;
  /** Major units (e.g. 1234.56), signed from the account's perspective. */
  amount: number;
  currency: string;
  description: string;
  merchant: string;
  notes: string;
}

/** Every non-deleted transaction, flattened with names, for CSV export. */
export async function getTransactionsForExport(
  userId: string,
): Promise<TransactionExportRow[]> {
  const rows = await db.query.transactions.findMany({
    where: and(eq(transactions.userId, userId), isNull(transactions.deletedAt)),
    with: {
      account: { columns: { name: true } },
      transferAccount: { columns: { name: true } },
      category: { columns: { name: true } },
    },
    orderBy: [desc(transactions.date), desc(transactions.createdAt)],
  });
  return rows.map((r) => ({
    date: r.date,
    type: r.type,
    status: r.status,
    account: r.account?.name ?? "",
    transferAccount: r.transferAccount?.name ?? "",
    category: r.category?.name ?? "",
    amount: minorToMajor(r.amountMinor, r.currencyCode),
    currency: r.currencyCode,
    description: r.description,
    merchant: r.merchant ?? "",
    notes: r.notes ?? "",
  }));
}

/**
 * A portable JSON dump of everything a user owns. Encrypted columns are
 * decrypted on read, so the export is plaintext (it's the user's own data).
 * Join tables for budgets/tags are omitted; pg_dump is the lossless backup.
 */
export async function getAccountDataExport(userId: string) {
  const [settings, acc, cats, tg, txns, bdg, bl, rec, goals] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) }),
    db.query.accounts.findMany({ where: eq(accounts.userId, userId) }),
    db.query.categories.findMany({ where: eq(categories.userId, userId) }),
    db.query.tags.findMany({ where: eq(tags.userId, userId) }),
    db.query.transactions.findMany({
      where: and(eq(transactions.userId, userId), isNull(transactions.deletedAt)),
    }),
    db.query.budgets.findMany({ where: eq(budgets.userId, userId) }),
    db.query.bills.findMany({ where: eq(bills.userId, userId) }),
    db.query.recurringTransactions.findMany({
      where: eq(recurringTransactions.userId, userId),
    }),
    db.query.savingsGoals.findMany({ where: eq(savingsGoals.userId, userId) }),
  ]);

  const txIds = txns.map((t) => t.id);
  const splits = txIds.length
    ? await db.query.transactionSplits.findMany({
        where: inArray(transactionSplits.transactionId, txIds),
      })
    : [];

  return {
    schema: "kosh-export-v1",
    exportedAt: new Date().toISOString(),
    settings: settings ?? null,
    accounts: acc,
    categories: cats,
    tags: tg,
    transactions: txns,
    transactionSplits: splits,
    budgets: bdg,
    bills: bl,
    recurringTransactions: rec,
    savingsGoals: goals,
  };
}
