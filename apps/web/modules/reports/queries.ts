import "server-only";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db, transactions } from "@kosh/db";
import {
  addMonthsClamped,
  financialYearRange,
  monthlyFlows,
  monthRange,
  netWorthSeries,
  spendingByCategory,
  todayIso,
  type MonthlyFlow,
  type NetWorthPoint,
} from "@kosh/domain";
import { getBalanceSnapshots } from "@/modules/accounts/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import { getUserSettings } from "@/modules/settings/queries";

async function reportTransactions(userId: string, sinceIso: string) {
  const { currencyCode } = await getUserSettings(userId);
  return db.query.transactions.findMany({
    where: and(
      eq(transactions.userId, userId),
      eq(transactions.currencyCode, currencyCode),
      isNull(transactions.deletedAt),
      gte(transactions.date, sinceIso),
      inArray(transactions.status, ["imported", "reviewed", "posted"]),
    ),
    columns: {
      date: true,
      amountMinor: true,
      type: true,
      status: true,
      categoryId: true,
    },
    orderBy: [asc(transactions.date)],
  });
}

export async function getMonthlyFlows(
  userId: string,
  months = 6,
): Promise<MonthlyFlow[]> {
  const since = monthRange(addMonthsClamped(todayIso(), -(months - 1))).start;
  const rows = await reportTransactions(userId, since);
  return monthlyFlows(rows);
}

export interface CategorySpendNamed {
  categoryId: string | null;
  name: string;
  color: string | null;
  spentMinor: number;
}

export async function getSpendingByCategory(
  userId: string,
  monthIso = todayIso(),
): Promise<CategorySpendNamed[]> {
  const { start, end } = monthRange(monthIso);
  const [rows, categories] = await Promise.all([
    reportTransactions(userId, start),
    listCategories(userId),
  ]);
  const names = new Map(categories.map((c) => [c.id, c]));
  return spendingByCategory(rows, start, end).map((spend) => ({
    ...spend,
    name: spend.categoryId
      ? (names.get(spend.categoryId)?.name ?? "Unknown")
      : "Uncategorized",
    color: spend.categoryId ? (names.get(spend.categoryId)?.color ?? null) : null,
  }));
}

export async function getNetWorthSeries(
  userId: string,
  months = 4,
): Promise<NetWorthPoint[]> {
  const since = addMonthsClamped(todayIso(), -months);
  const snapshots = await getBalanceSnapshots(userId, since);
  return netWorthSeries(snapshots);
}

export interface DailyCashflowPoint {
  date: string;
  inflowMinor: number;
  outflowMinor: number;
  netMinor: number;
}

/** Daily inflow/outflow for the last `days` days (excludes transfers). */
export async function getRecentCashflow(
  userId: string,
  days = 30,
): Promise<DailyCashflowPoint[]> {
  const today = todayIso();
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const since = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, "0")}-${String(sinceDate.getDate()).padStart(2, "0")}`;

  const rows = await reportTransactions(userId, since);
  const byDate = new Map<string, { inflow: number; outflow: number }>();
  for (const tx of rows) {
    if (tx.type !== "income" && tx.type !== "expense") continue;
    const entry = byDate.get(tx.date) ?? { inflow: 0, outflow: 0 };
    if (tx.amountMinor > 0) entry.inflow += tx.amountMinor;
    else entry.outflow += -tx.amountMinor;
    byDate.set(tx.date, entry);
  }

  const points: DailyCashflowPoint[] = [];
  for (let d = new Date(sinceDate); ; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (iso > today) break;
    const entry = byDate.get(iso) ?? { inflow: 0, outflow: 0 };
    points.push({
      date: iso,
      inflowMinor: entry.inflow,
      outflowMinor: entry.outflow,
      netMinor: entry.inflow - entry.outflow,
    });
  }
  return points;
}

export interface FinancialYearSummary {
  label: string;
  start: string;
  end: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  /** Saved share of income, 0-100 (0 when there's no income yet). */
  savingsRatePct: number;
}

/** Income/expense/savings for the current financial year (region-aware). */
export async function getFinancialYearSummary(
  userId: string,
  startMonth: number,
): Promise<FinancialYearSummary> {
  const { start, end, label } = financialYearRange(todayIso(), startMonth);
  const { currencyCode } = await getUserSettings(userId);
  const rows = await db.query.transactions.findMany({
    where: and(
      eq(transactions.userId, userId),
      eq(transactions.currencyCode, currencyCode),
      isNull(transactions.deletedAt),
      gte(transactions.date, start),
      lte(transactions.date, end),
      inArray(transactions.status, ["imported", "reviewed", "posted"]),
    ),
    columns: { amountMinor: true, type: true },
  });
  let income = 0;
  let expense = 0;
  for (const tx of rows) {
    if (tx.type === "income" && tx.amountMinor > 0) income += tx.amountMinor;
    if (tx.type === "expense" && tx.amountMinor < 0) expense += -tx.amountMinor;
  }
  const net = income - expense;
  return {
    label,
    start,
    end,
    incomeMinor: income,
    expenseMinor: expense,
    netMinor: net,
    savingsRatePct: income > 0 ? Math.round((net / income) * 100) : 0,
  };
}

/** Income/expense/net headline numbers for the month containing `monthIso`. */
export async function getMonthSummaryFor(userId: string, monthIso: string) {
  const { start, end } = monthRange(monthIso);
  const all = await reportTransactions(userId, start);
  const rows = all.filter((tx) => tx.date <= end);
  let income = 0;
  let expense = 0;
  for (const tx of rows) {
    if (tx.type === "income" && tx.amountMinor > 0) income += tx.amountMinor;
    if (tx.type === "expense" && tx.amountMinor < 0) expense += -tx.amountMinor;
  }
  return { incomeMinor: income, expenseMinor: expense, netMinor: income - expense };
}

/** This month's income/expense headline numbers. */
export async function getMonthSummary(userId: string) {
  return getMonthSummaryFor(userId, todayIso());
}
