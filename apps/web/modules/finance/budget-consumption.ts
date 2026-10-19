import "server-only";
import { and, asc, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  budgetPeriods,
  budgets,
  creditCardPurchases,
  db,
  installmentPlans,
  installments,
  transactions,
} from "@kosh/db";
import { monthRange } from "@kosh/domain";
import {
  addStatementMonths,
  projectBudgetConsumption,
  ROUTE_HISTORY_MONTHS,
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
  events: [],
  cardCharges: [],
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

  // Recent months are read only for which card or account paid them.
  const historyFrom = `${addStatementMonths(asOf.slice(0, 7), -ROUTE_HISTORY_MONTHS)}-01`;
  const through = monthRange(horizonEnd).end;
  const spendRows = await db.query.transactions.findMany({
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
  });

  const projectedParcels = await loadProjectedParcels(
    input.cards.map((card) => card.id),
    categoryIds,
    asOf,
    // A parcel due the month after the horizon may still be billed inside it.
    monthRange(`${addStatementMonths(through.slice(0, 7), 1)}-01`).end,
  );
  const cardIdByAccountId = new Map(input.cards.map((card) => [card.accountId, card.id]));
  const result = projectBudgetConsumption({
    asOf,
    horizonEnd,
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
    projectedParcels,
    cards: input.cards.map(({ id, closingDay, dueDay }) => ({ id, closingDay, dueDay })),
  });

  return { ...result, budgetNames: new Map(budgetRows.map((budget) => [budget.id, budget.name])) };
}

/**
 * Parcels still projected on future statements, in budgeted categories, for
 * purchases whose parcels the ledger books one by one.
 *
 * Open Finance delivers one transaction per parcel (docs/OPEN-FINANCE.md), so
 * each of these will land in the ledger — and in the budget — when its
 * statement is billed, while the forecast already carries its cash on that
 * statement. Left out of `committed`, it would be counted again by the
 * estimate. A purchase entered by hand is one full-value transaction already
 * in `spent`; its parcels never reach the ledger, so it is excluded: the
 * purchase row is not itself one of the plan's parcels.
 */
async function loadProjectedParcels(cardIds: string[], categoryIds: string[], from: string, to: string) {
  if (cardIds.length === 0) return [];
  const linked = alias(installments, "linked");
  const rows = await db
    .select({
      cardId: creditCardPurchases.creditCardId,
      dueAt: installments.expectedAt,
      amountMinor: installments.amountMinor,
      purchaseCategoryId: creditCardPurchases.categoryId,
      transactionCategoryId: transactions.categoryId,
    })
    .from(installments)
    .innerJoin(installmentPlans, eq(installmentPlans.id, installments.installmentPlanId))
    .innerJoin(creditCardPurchases, eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId))
    .innerJoin(transactions, eq(transactions.id, creditCardPurchases.transactionId))
    // Only plans whose purchase row is itself one of the parcels.
    .innerJoin(
      linked,
      and(eq(linked.installmentPlanId, installmentPlans.id), eq(linked.transactionId, transactions.id)),
    )
    .where(
      and(
        inArray(creditCardPurchases.creditCardId, cardIds),
        eq(installments.status, "projected"),
        gte(installments.expectedAt, from),
        lte(installments.expectedAt, to),
      ),
    );
  const budgeted = new Set(categoryIds);
  return rows.flatMap((row) => {
    const categoryId = row.purchaseCategoryId ?? row.transactionCategoryId;
    if (!categoryId || !budgeted.has(categoryId)) return [];
    return [{ categoryId, cardId: row.cardId, dueAt: row.dueAt, amountMinor: row.amountMinor }];
  });
}
