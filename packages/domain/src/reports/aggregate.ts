/** Report aggregation helpers — pure functions over ledger rows. */

import { countsTowardLedger, type TransactionStatus, type TransactionType } from "../ledger";

export interface ReportTransaction {
  date: string;
  amountMinor: number;
  type: TransactionType;
  status: TransactionStatus;
  categoryId: string | null;
}

export interface MonthlyFlow {
  /** "yyyy-MM" */
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** Income vs expense per month. Transfers and adjustments are excluded. */
export function monthlyFlows(transactions: ReportTransaction[]): MonthlyFlow[] {
  const months = new Map<string, { income: number; expense: number }>();
  for (const tx of transactions) {
    if (!countsTowardLedger(tx.status)) continue;
    if (tx.type !== "income" && tx.type !== "expense") continue;
    const key = monthKey(tx.date);
    const entry = months.get(key) ?? { income: 0, expense: 0 };
    if (tx.type === "income" && tx.amountMinor > 0) entry.income += tx.amountMinor;
    if (tx.type === "expense" && tx.amountMinor < 0) entry.expense += -tx.amountMinor;
    months.set(key, entry);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, { income, expense }]) => ({
      month,
      incomeMinor: income,
      expenseMinor: expense,
      netMinor: income - expense,
    }));
}

export interface CategorySpend {
  categoryId: string | null;
  spentMinor: number;
}

/** Absolute spending per category within an optional window. */
export function spendingByCategory(
  transactions: ReportTransaction[],
  start?: string,
  end?: string,
): CategorySpend[] {
  const byCategory = new Map<string | null, number>();
  for (const tx of transactions) {
    if (!countsTowardLedger(tx.status)) continue;
    if (tx.type !== "expense" || tx.amountMinor >= 0) continue;
    if (start && tx.date < start) continue;
    if (end && tx.date > end) continue;
    byCategory.set(tx.categoryId, (byCategory.get(tx.categoryId) ?? 0) + -tx.amountMinor);
  }
  return [...byCategory.entries()]
    .map(([categoryId, spentMinor]) => ({ categoryId, spentMinor }))
    .sort((a, b) => b.spentMinor - a.spentMinor);
}

export interface NetWorthPoint {
  date: string;
  netWorthMinor: number;
}

/**
 * Net worth series from per-account daily balance snapshots. For each date in
 * the union of snapshot dates, carry the latest known balance per account
 * forward, then sum.
 */
export function netWorthSeries(
  snapshots: Array<{ accountId: string; date: string; balanceMinor: number }>,
): NetWorthPoint[] {
  const dates = [...new Set(snapshots.map((s) => s.date))].sort();
  const byAccount = new Map<string, Array<{ date: string; balanceMinor: number }>>();
  for (const snap of snapshots) {
    const list = byAccount.get(snap.accountId) ?? [];
    list.push(snap);
    byAccount.set(snap.accountId, list);
  }
  for (const list of byAccount.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  const cursors = new Map<string, number>();
  const lastKnown = new Map<string, number>();
  return dates.map((date) => {
    let total = 0;
    for (const [accountId, list] of byAccount) {
      let cursor = cursors.get(accountId) ?? 0;
      while (cursor < list.length && list[cursor]!.date <= date) {
        lastKnown.set(accountId, list[cursor]!.balanceMinor);
        cursor += 1;
      }
      cursors.set(accountId, cursor);
      total += lastKnown.get(accountId) ?? 0;
    }
    return { date, netWorthMinor: total };
  });
}
