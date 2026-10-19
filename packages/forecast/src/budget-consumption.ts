import {
  addDaysIso,
  assertMinorUnits,
  assertValidDate,
  type Confidence,
  type DateString,
  type ForecastEvent,
} from "./forecast";
import { addStatementMonths, nominalCycleFor } from "./projections";

/**
 * Which estimate of variable consumption the forecast carries.
 *
 * `none` is the commitments-only trajectory; `base` expects the categories to
 * spend what they usually do; `conservative` expects the larger of that and
 * whatever is still left in the budget.
 */
export type VariableSpendingScenario = "none" | "base" | "conservative";

export const BUDGET_ESTIMATE_SOURCE = "budget_estimate";

/** Complete months of history the base scenario needs before trusting it. */
export const BUDGET_HISTORY_MONTHS = 3;

export interface ConsumptionBudget {
  id: string;
  categoryIds: string[];
  /**
   * Planned amount per month, keyed `YYYY-MM`. A month without an entry reuses
   * the latest earlier one — the same roll-forward Kosh's period job applies —
   * so next month is budgeted before the job has run for it.
   */
  plannedByMonth: Record<string, number>;
}

/** One expense already in the ledger, dated when it was incurred (PRD R4). */
export interface ConsumptionSpend {
  categoryId: string;
  date: DateString;
  /** Positive magnitude. */
  amountMinor: number;
  /** The card that paid it, or null for any cash account. */
  cardId: string | null;
}

/**
 * An outflow the forecast already projects in a category — a bill, a recurring
 * rule, a persisted event — dated when it is incurred, not when cash moves.
 */
export interface ConsumptionCommitment {
  categoryId: string;
  date: DateString;
  /** Positive magnitude. */
  amountMinor: number;
}

export interface ConsumptionCard {
  id: string;
  closingDay: number;
  dueDay: number;
}

export interface BudgetConsumptionInput {
  asOf: DateString;
  horizonEnd: DateString;
  /**
   * First day the ledger has data for. A month that starts before it is
   * absence of data, not a month of zero spending, and must not drag the
   * historical median down. Null when the ledger is empty.
   */
  historyStart: DateString | null;
  budgets: ConsumptionBudget[];
  spending: ConsumptionSpend[];
  commitments: ConsumptionCommitment[];
  /** Active cards. Spending on a card not listed here is treated as cash. */
  cards: ConsumptionCard[];
}

export interface ConsumptionRoute {
  cardId: string | null;
  /** Share of the estimate this route carries, in basis points (sums to 10 000). */
  shareBasisPoints: number;
}

export interface BudgetMonthEstimate {
  budgetId: string;
  /** `YYYY-MM`. */
  month: string;
  /** Null when the budget has no planned amount for this month or any before it. */
  plannedMinor: number | null;
  spentMinor: number;
  committedMinor: number;
  /** `max(0, planned − spent − committed)`; null without a planned amount. */
  budgetRemainingMinor: number | null;
  /** Median monthly spending of the categories; null without enough history. */
  historicalMonthlyMinor: number | null;
  historyMonths: number;
  /** What the base scenario rests on: the categories' history, or the budget as fallback. */
  baseBasis: "history" | "budget";
  baseRemainingMinor: number;
  conservativeRemainingMinor: number;
  baseConfidence: Confidence;
  conservativeConfidence: Confidence;
  routes: ConsumptionRoute[];
}

export interface BudgetConsumptionBlocker {
  budgetId: string;
  code: "CATEGORY_IN_MULTIPLE_BUDGETS";
  categoryId: string;
}

export interface BudgetConsumptionResult {
  estimates: BudgetMonthEstimate[];
  events: Record<Exclude<VariableSpendingScenario, "none">, ForecastEvent[]>;
  blockers: BudgetConsumptionBlocker[];
}

function monthOf(date: DateString): string {
  return date.slice(0, 7);
}

function firstDay(month: string): DateString {
  return `${month}-01`;
}

function lastDay(month: string): DateString {
  const [year, monthNumber] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function plannedFor(budget: ConsumptionBudget, month: string): number | null {
  let best: string | undefined;
  for (const key of Object.keys(budget.plannedByMonth)) {
    if (key <= month && (best === undefined || key > best)) best = key;
  }
  return best === undefined ? null : budget.plannedByMonth[best]!;
}

/**
 * Splits `amountMinor` by integer weights with the largest-remainder method,
 * so the parts are whole minor units that sum back to the amount exactly.
 * Ties go to the earlier weight, which keeps the split deterministic.
 */
function splitByWeights(amountMinor: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map((_weight, index) => (index === 0 ? amountMinor : 0));
  const exact = weights.map((weight) => (amountMinor * weight) / total);
  const parts = exact.map(Math.floor);
  let leftover = amountMinor - parts.reduce((sum, part) => sum + part, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const { index } of order) {
    if (leftover <= 0) break;
    parts[index]! += 1;
    leftover -= 1;
  }
  return parts;
}

function validate(input: BudgetConsumptionInput): void {
  assertValidDate(input.asOf, "asOf");
  assertValidDate(input.horizonEnd, "horizonEnd");
  if (input.historyStart !== null) assertValidDate(input.historyStart, "historyStart");
  for (const budget of input.budgets) {
    for (const [month, planned] of Object.entries(budget.plannedByMonth)) {
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`budget ${budget.id} planned month must be YYYY-MM`);
      assertMinorUnits(planned, `budget ${budget.id} planned amount`);
    }
  }
  for (const spend of input.spending) {
    assertValidDate(spend.date, "spend.date");
    assertMinorUnits(spend.amountMinor, "spend.amountMinor");
    if (spend.amountMinor < 0) throw new Error("spend.amountMinor must be a positive magnitude");
  }
  for (const commitment of input.commitments) {
    assertValidDate(commitment.date, "commitment.date");
    assertMinorUnits(commitment.amountMinor, "commitment.amountMinor");
    if (commitment.amountMinor < 0) throw new Error("commitment.amountMinor must be a positive magnitude");
  }
}

/**
 * Estimates the variable spending budgeted categories still have ahead, and
 * dates it as cash.
 *
 * A budget is what the user intends to spend, not something expected to happen
 * (PRD §8), so it never enters the forecast as itself. What enters is an
 * estimate derived from it, carried as its own low-confidence source so the
 * projection keeps saying how much of it is assumption (R7, §61).
 *
 * Per budget and month, on the economic calendar (R4):
 *
 *   remaining = max(0, planned − spent − committed)
 *
 * `spent` is what the ledger already holds, card purchases included at their
 * purchase date. `committed` is what the forecast already projects in the same
 * categories — subtracting it is what stops a bill in a budgeted category from
 * being counted once as a bill and again as budget (R3). Installments of older
 * purchases are not in it: their expense belongs to the month they were bought.
 *
 * The base scenario replaces `planned` with the categories' median monthly
 * spending over the last complete months, because real history outranks a
 * manual estimate (R1); without enough history it falls back to the budget.
 * The conservative scenario takes the larger of the two, so it is never the
 * more optimistic one.
 *
 * Cash dating follows how the categories were paid in that same history: the
 * cash share is spread across the days left in the month, and each card's
 * share leaves on the due date of the statement open on the day it would be
 * spent. Card shares stay separate events rather than joining the statement's
 * total, which would relabel a guess with the statement's confidence.
 */
export function projectBudgetConsumption(input: BudgetConsumptionInput): BudgetConsumptionResult {
  validate(input);
  const result: BudgetConsumptionResult = { estimates: [], events: { base: [], conservative: [] }, blockers: [] };
  if (input.horizonEnd < input.asOf) return result;

  // A category in two budgets has no single remaining amount: either budget's
  // estimate would count the other's spending. Neither is estimated.
  const owners = new Map<string, string[]>();
  for (const budget of input.budgets) {
    for (const categoryId of new Set(budget.categoryIds)) {
      owners.set(categoryId, [...(owners.get(categoryId) ?? []), budget.id]);
    }
  }
  const blocked = new Set<string>();
  for (const [categoryId, budgetIds] of owners) {
    if (budgetIds.length < 2) continue;
    for (const budgetId of budgetIds) {
      blocked.add(budgetId);
      result.blockers.push({ budgetId, code: "CATEGORY_IN_MULTIPLE_BUDGETS", categoryId });
    }
  }

  const cardById = new Map(input.cards.map((card) => [card.id, card]));
  const currentMonth = monthOf(input.asOf);
  const historyMonthsList = Array.from({ length: BUDGET_HISTORY_MONTHS }, (_unused, index) =>
    addStatementMonths(currentMonth, index - BUDGET_HISTORY_MONTHS),
  );
  // Only a month the ledger covers from its first day counts as history.
  const coveredMonths = historyMonthsList.filter(
    (month) => input.historyStart !== null && input.historyStart <= firstDay(month),
  );
  const months: string[] = [];
  for (let month = currentMonth; month <= monthOf(input.horizonEnd); month = addStatementMonths(month, 1)) {
    months.push(month);
  }

  for (const budget of input.budgets) {
    if (blocked.has(budget.id)) continue;
    const categories = new Set(budget.categoryIds);
    const spending = input.spending.filter((spend) => categories.has(spend.categoryId));
    const commitments = input.commitments.filter(
      (commitment) => categories.has(commitment.categoryId) && commitment.date >= input.asOf,
    );

    const spentByMonth = new Map<string, number>();
    for (const spend of spending) {
      const month = monthOf(spend.date);
      spentByMonth.set(month, (spentByMonth.get(month) ?? 0) + spend.amountMinor);
    }
    const historyValues = coveredMonths.map((month) => spentByMonth.get(month) ?? 0);
    const historical = coveredMonths.length === BUDGET_HISTORY_MONTHS ? median(historyValues) : null;

    // Route mix over the whole history window, covered or not: a partial month
    // still says which card the categories are paid with.
    const routeWeights = new Map<string | null, number>([[null, 0]]);
    for (const spend of spending) {
      if (!historyMonthsList.includes(monthOf(spend.date))) continue;
      const route = spend.cardId !== null && cardById.has(spend.cardId) ? spend.cardId : null;
      routeWeights.set(route, (routeWeights.get(route) ?? 0) + spend.amountMinor);
    }
    const routeIds = [null, ...[...routeWeights.keys()].filter((id): id is string => id !== null).sort()];
    // With no history at all every weight is zero and the whole share goes to
    // cash, the route that leaves soonest.
    const shares = splitByWeights(10_000, routeIds.map((id) => routeWeights.get(id) ?? 0));
    const routes = routeIds
      .map((cardId, index) => ({ cardId, shareBasisPoints: shares[index]! }))
      .filter((route) => route.shareBasisPoints > 0);

    for (const month of months) {
      const planned = plannedFor(budget, month);
      if (planned === null && historical === null) continue;

      const spentMinor = spentByMonth.get(month) ?? 0;
      const committedMinor = commitments
        .filter((commitment) => monthOf(commitment.date) === month)
        .reduce((sum, commitment) => sum + commitment.amountMinor, 0);
      const budgetRemainingMinor = planned === null ? null : Math.max(0, planned - spentMinor - committedMinor);
      const historyRemainingMinor =
        historical === null ? null : Math.max(0, historical - spentMinor - committedMinor);

      const baseBasis = historyRemainingMinor !== null ? "history" : "budget";
      const baseRemainingMinor = historyRemainingMinor ?? budgetRemainingMinor ?? 0;
      const conservativeRemainingMinor = Math.max(baseRemainingMinor, budgetRemainingMinor ?? 0);
      const baseConfidence: Confidence = baseBasis === "history" ? "MEDIUM" : "LOW";
      // The conservative figure keeps history's confidence only when history is
      // what it came from; a budget cap is a manual estimate.
      const conservativeConfidence: Confidence =
        baseBasis === "history" && baseRemainingMinor >= (budgetRemainingMinor ?? 0) ? "MEDIUM" : "LOW";

      result.estimates.push({
        budgetId: budget.id,
        month,
        plannedMinor: planned,
        spentMinor,
        committedMinor,
        budgetRemainingMinor,
        historicalMonthlyMinor: historical,
        historyMonths: coveredMonths.length,
        baseBasis,
        baseRemainingMinor,
        conservativeRemainingMinor,
        baseConfidence,
        conservativeConfidence,
        routes,
      });

      const from = month === currentMonth ? input.asOf : firstDay(month);
      const days: DateString[] = [];
      for (let day = from; day <= lastDay(month); day = addDaysIso(day, 1)) days.push(day);

      result.events.base.push(...datedEvents(budget.id, month, baseRemainingMinor, baseConfidence, routes, days, cardById));
      result.events.conservative.push(
        ...datedEvents(budget.id, month, conservativeRemainingMinor, conservativeConfidence, routes, days, cardById),
      );
    }
  }

  return result;
}

function datedEvents(
  budgetId: string,
  month: string,
  amountMinor: number,
  confidence: Confidence,
  routes: ConsumptionRoute[],
  days: DateString[],
  cardById: Map<string, ConsumptionCard>,
): ForecastEvent[] {
  if (amountMinor <= 0 || days.length === 0) return [];
  const events: ForecastEvent[] = [];
  const shares = splitByWeights(
    amountMinor,
    routes.map((route) => route.shareBasisPoints),
  );

  routes.forEach((route, index) => {
    const share = shares[index]!;
    if (share <= 0) return;
    // Even daily pace; the leftover minor units land on the earliest days,
    // which errs toward the money leaving sooner.
    const perDay = splitByWeights(share, days.map(() => 1));

    if (route.cardId === null) {
      days.forEach((day, dayIndex) => {
        if (perDay[dayIndex]! <= 0) return;
        const key = `budget:${budgetId}:${month}:cash:${day}`;
        events.push({
          id: key,
          logicalKey: key,
          expectedAt: day,
          amountMinor: -perDay[dayIndex]!,
          sourceType: BUDGET_ESTIMATE_SOURCE,
          confidence,
        });
      });
      return;
    }

    const card = cardById.get(route.cardId)!;
    const byStatement = new Map<string, { dueAt: DateString; amountMinor: number }>();
    days.forEach((day, dayIndex) => {
      const cycle = nominalCycleFor(day, card.closingDay, card.dueDay);
      const entry = byStatement.get(cycle.statementMonth) ?? { dueAt: cycle.dueAt, amountMinor: 0 };
      entry.amountMinor += perDay[dayIndex]!;
      byStatement.set(cycle.statementMonth, entry);
    });
    for (const [statementMonth, entry] of byStatement) {
      if (entry.amountMinor <= 0) continue;
      const key = `budget:${budgetId}:${month}:card:${card.id}:${statementMonth}`;
      events.push({
        id: key,
        logicalKey: key,
        expectedAt: entry.dueAt,
        amountMinor: -entry.amountMinor,
        sourceType: BUDGET_ESTIMATE_SOURCE,
        confidence,
      });
    }
  });

  return events;
}
