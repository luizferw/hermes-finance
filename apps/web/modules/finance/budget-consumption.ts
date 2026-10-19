import "server-only";
import { and, asc, eq, gte, inArray, isNull, lt, lte, min } from "drizzle-orm";
import { budgetPeriods, budgets, db, transactions } from "@kosh/db";
import { monthRange } from "@kosh/domain";
import {
  addStatementMonths,
  BUDGET_HISTORY_MONTHS,
  projectBudgetConsumption,
  type BudgetConsumptionResult,
  type ConsumptionCard,
  type ConsumptionCommitment,
} from "@hermes-finance/forecast";

/** Ledger statuses that count as spending, the same set Kosh's budget progress uses. */
const SPENT_STATUSES = ["imported", "reviewed", "posted"] as const;

export interface BudgetConsumption extends BudgetConsumptionResult {
  /** Budget names keyed by id, for labelling estimates and blockers. */
  budgetNames: Map<string, string>;
}

const EMPTY: BudgetConsumption = {
  estimates: [],
  events: { base: [], conservative: [] },
  blockers: [],
  budgetNames: new Map(),
};

/**
 * Reads what `projectBudgetConsumption` needs and runs it. No arithmetic on
 * money happens here beyond normalizing signs; the engine owns the estimate.
 *
 * `commitments` are the outflows the forecast already carries, dated when they
 * are incurred, and `cards` the active cards — both come from the forecast's own
 * reads so the estimate and the projection it joins agree on what exists.
 */
export async function loadBudgetConsumption(input: {
  userId: string;
  asOf: string;
  horizonEnd: string;
  currencyCode: string;
  cards: Array<ConsumptionCard & { accountId: string }>;
  commitments: ConsumptionCommitment[];
}): Promise<BudgetConsumption> {
  const { userId, asOf, horizonEnd, currencyCode } = input;

  const budgetRows = await db.query.budgets.findMany({
    where: and(eq(budgets.userId, userId), eq(budgets.isArchived, false)),
    with: {
      budgetCategories: true,
      periods: {
        where: and(eq(budgetPeriods.currencyCode, currencyCode), lte(budgetPeriods.periodStart, horizonEnd)),
      },
    },
    orderBy: [asc(budgets.name)],
  });
  const categoryIds = [...new Set(budgetRows.flatMap((budget) => budget.budgetCategories.map((bc) => bc.categoryId)))];
  if (categoryIds.length === 0) return EMPTY;

  const historyFrom = `${addStatementMonths(asOf.slice(0, 7), -BUDGET_HISTORY_MONTHS)}-01`;
  const through = monthRange(horizonEnd).end;
  const [spendRows, [first]] = await Promise.all([
    db.query.transactions.findMany({
      where: and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        eq(transactions.type, "expense"),
        inArray(transactions.status, [...SPENT_STATUSES]),
        eq(transactions.currencyCode, currencyCode),
        inArray(transactions.categoryId, categoryIds),
        lt(transactions.amountMinor, 0),
        gte(transactions.date, historyFrom),
        lte(transactions.date, through),
      ),
      columns: { categoryId: true, date: true, amountMinor: true, accountId: true },
    }),
    db
      .select({ value: min(transactions.date) })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNull(transactions.deletedAt))),
  ]);

  const cardIdByAccountId = new Map(input.cards.map((card) => [card.accountId, card.id]));
  const result = projectBudgetConsumption({
    asOf,
    horizonEnd,
    historyStart: first?.value ?? null,
    budgets: budgetRows.map((budget) => ({
      id: budget.id,
      categoryIds: budget.budgetCategories.map((bc) => bc.categoryId),
      plannedByMonth: Object.fromEntries(
        budget.periods.map((period) => [period.periodStart.slice(0, 7), period.plannedAmountMinor]),
      ),
    })),
    spending: spendRows.map((row) => ({
      categoryId: row.categoryId!,
      date: row.date,
      amountMinor: -row.amountMinor,
      cardId: cardIdByAccountId.get(row.accountId) ?? null,
    })),
    commitments: input.commitments,
    cards: input.cards.map(({ id, closingDay, dueDay }) => ({ id, closingDay, dueDay })),
  });

  return { ...result, budgetNames: new Map(budgetRows.map((budget) => [budget.id, budget.name])) };
}
