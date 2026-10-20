import {
  addDaysIso,
  assertMinorUnits,
  assertValidDate,
  type Confidence,
  type DateString,
  type ForecastEvent,
} from "./forecast";
import { addStatementMonths, nominalCycleFor, statementMonthForDueDate } from "./projections";

/**
 * Whether the forecast carries the variable spending budgets still allow.
 * `none` is the commitments-only trajectory.
 */
export type VariableSpendingScenario = "none" | "budget";

export const BUDGET_ESTIMATE_SOURCE = "budget_estimate";

/** A budget is a manual estimate, the lowest rung of R1's precedence. */
const ESTIMATE_CONFIDENCE: Confidence = "LOW";

/** Recent months whose payment mix decides which route an estimate is paid by. */
export const ROUTE_HISTORY_MONTHS = 3;

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

/** Where a committed amount comes from, so `committedMinor` can be taken apart. */
export type CommitmentSourceKind = "bill" | "recurring_rule" | "projected_event" | "card_parcel";

export interface CommitmentSource {
  kind: CommitmentSourceKind;
  /** The bill, rule, persisted event or card purchase id. */
  id: string;
  /** Human name: the bill or rule name, the event type, the purchase description. */
  label: string;
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
  /** Optional provenance; without it the amount is reported as kind `other`. */
  source?: CommitmentSource;
}

/**
 * A card installment the forecast already carries on a future statement, for a
 * purchase whose parcels the ledger books one by one (as Open Finance does).
 * Each such parcel lands in the ledger, and so in the budget, in the month of
 * its statement — so it is spending already committed for that month.
 */
export interface ConsumptionParcel {
  categoryId: string;
  cardId: string;
  /** The statement's due date the parcel is billed on. */
  dueAt: DateString;
  /** Positive magnitude. */
  amountMinor: number;
  /** The purchase the parcel belongs to, for `committedBySource`. */
  purchaseId?: string;
  label?: string;
}

export interface ConsumptionCard {
  id: string;
  closingDay: number;
  dueDay: number;
}

export interface BudgetConsumptionInput {
  asOf: DateString;
  horizonEnd: DateString;
  budgets: ConsumptionBudget[];
  spending: ConsumptionSpend[];
  commitments: ConsumptionCommitment[];
  /** Projected parcels of purchases already made; see `ConsumptionParcel`. */
  projectedParcels: ConsumptionParcel[];
  /** Active cards. Spending on a card not listed here is treated as cash. */
  cards: ConsumptionCard[];
}

export interface ConsumptionRoute {
  cardId: string | null;
  /** Share of the estimate this route carries, in basis points (sums to 10 000). */
  shareBasisPoints: number;
}

/** One source's part of `committedMinor` in a month, summed over its occurrences. */
export interface CommittedBySource {
  kind: CommitmentSourceKind | "other";
  sourceId: string | null;
  label: string;
  /** How many dated occurrences (bill instances, parcels, …) were summed. */
  occurrences: number;
  /** Earliest occurrence in the month. */
  firstDate: DateString;
  /** Positive magnitude. */
  amountMinor: number;
}

/** How much of one month's remaining amount one route carries, and when it leaves. */
export interface RouteAllocation {
  /** null for cash. */
  cardId: string | null;
  shareBasisPoints: number;
  /** This route's part of `remainingMinor`; the parts sum to it exactly. */
  amountMinor: number;
  /** The part settling after the horizon (a card statement due past it). */
  beyondHorizonMinor: number;
  /** Dates the route's events land on (cash: first and last day; card: each statement due date). */
  settlementDates: DateString[];
}

export interface BudgetMonthEstimate {
  budgetId: string;
  /** `YYYY-MM`. */
  month: string;
  plannedMinor: number;
  spentMinor: number;
  committedMinor: number;
  /** `committedMinor` taken apart by source; the amounts sum to it exactly. */
  committedBySource: CommittedBySource[];
  /** `max(0, planned − spent − committed)`: what the forecast sets aside. */
  remainingMinor: number;
  routes: ConsumptionRoute[];
  /** `remainingMinor` split by route; sums to it exactly. */
  allocations: RouteAllocation[];
  /**
   * Part of `remainingMinor` whose events fall after `horizonEnd` — a card share
   * billed on a statement due past it. Those events exist but the forecast over
   * this horizon does not carry them; inside it, the events sum to
   * `remainingMinor − beyondHorizonMinor`.
   */
  beyondHorizonMinor: number;
}

export interface BudgetConsumptionBlocker {
  budgetId: string;
  code: "CATEGORY_IN_MULTIPLE_BUDGETS";
  categoryId: string;
}

/**
 * One day's estimated spending on a card: it takes up the card's limit on the
 * day it is spent and frees it when the statement billing it is paid — the
 * date of the matching card event.
 */
export interface BudgetCardCharge {
  cardId: string;
  chargedAt: DateString;
  settlesAt: DateString;
  /** Positive magnitude. */
  amountMinor: number;
}

export interface BudgetConsumptionResult {
  estimates: BudgetMonthEstimate[];
  events: ForecastEvent[];
  /** The card share of `events`, day by day, for the cards' limits. */
  cardCharges: BudgetCardCharge[];
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
  for (const parcel of input.projectedParcels) {
    assertValidDate(parcel.dueAt, "parcel.dueAt");
    assertMinorUnits(parcel.amountMinor, "parcel.amountMinor");
    if (parcel.amountMinor < 0) throw new Error("parcel.amountMinor must be a positive magnitude");
  }
  for (const commitment of input.commitments) {
    assertValidDate(commitment.date, "commitment.date");
    assertMinorUnits(commitment.amountMinor, "commitment.amountMinor");
    if (commitment.amountMinor < 0) throw new Error("commitment.amountMinor must be a positive magnitude");
  }
}

/**
 * Estimates the variable spending budgeted categories may still have ahead,
 * and dates it as cash.
 *
 * A budget is what the user intends to spend, not something expected to happen
 * (PRD §8), so it never enters the forecast as itself. What enters is what is
 * left of it, carried as its own source at LOW confidence — a manual estimate
 * (R1) — so the projection keeps saying how much of it is assumption (R7, §61).
 * The budget is the ceiling: history never raises it.
 *
 * Per budget and month:
 *
 *   remaining = max(0, planned − spent − committed)
 *
 * `spent` is what the ledger already holds in the categories, measured the way
 * Kosh's budget progress measures it. `committed` is what the forecast already
 * projects in them — bills, recurring rules, and the parcels of past purchases
 * waiting on future statements. Subtracting it is what stops a bill or a parcel
 * in a budgeted category from being counted once as itself and again as
 * budget (R3). Parcels count in the month of their statement because that is
 * where the ledger books them when Open Finance delivers one transaction per
 * parcel.
 *
 * Cash dating follows how the categories were paid over the last few months:
 * the cash share is spread across the days left in the month, and each card's
 * share leaves on the due date of the statement open on the day it would be
 * spent. Card shares stay separate events rather than joining the statement's
 * total, which would relabel a guess with the statement's confidence.
 *
 * Every unit of `remaining` becomes an event, whatever the horizon. A card share
 * spent late in a month can settle on a statement due after `horizonEnd`; that
 * event still exists, but a forecast over the horizon drops it, so each estimate
 * reports it as `beyondHorizonMinor` instead of letting it vanish.
 */
export function projectBudgetConsumption(input: BudgetConsumptionInput): BudgetConsumptionResult {
  validate(input);
  const result: BudgetConsumptionResult = { estimates: [], events: [], cardCharges: [], blockers: [] };
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

  // A parcel is booked when its statement closes. One whose statement already
  // closed but has not posted yet is still due this month, so it is dated today.
  const commitmentsWithParcels: ConsumptionCommitment[] = [...input.commitments];
  for (const parcel of input.projectedParcels) {
    const card = cardById.get(parcel.cardId);
    if (!card) continue;
    const statementMonth = statementMonthForDueDate(parcel.dueAt, card.closingDay, card.dueDay);
    const closesAt = `${statementMonth}-${String(Math.min(card.closingDay, Number(lastDay(statementMonth).slice(8)))).padStart(2, "0")}`;
    commitmentsWithParcels.push({
      categoryId: parcel.categoryId,
      date: closesAt < input.asOf ? input.asOf : closesAt,
      amountMinor: parcel.amountMinor,
      source: {
        kind: "card_parcel",
        id: parcel.purchaseId ?? parcel.cardId,
        label: parcel.label ?? "card parcel",
      },
    });
  }
  const currentMonth = monthOf(input.asOf);
  const routeMonths = Array.from({ length: ROUTE_HISTORY_MONTHS }, (_unused, index) =>
    addStatementMonths(currentMonth, index - ROUTE_HISTORY_MONTHS),
  );
  const months: string[] = [];
  for (let month = currentMonth; month <= monthOf(input.horizonEnd); month = addStatementMonths(month, 1)) {
    months.push(month);
  }

  for (const budget of input.budgets) {
    if (blocked.has(budget.id)) continue;
    const categories = new Set(budget.categoryIds);
    const spending = input.spending.filter((spend) => categories.has(spend.categoryId));
    const commitments = commitmentsWithParcels.filter(
      (commitment) => categories.has(commitment.categoryId) && commitment.date >= input.asOf,
    );

    const spentByMonth = new Map<string, number>();
    for (const spend of spending) {
      const month = monthOf(spend.date);
      spentByMonth.set(month, (spentByMonth.get(month) ?? 0) + spend.amountMinor);
    }
    const routeWeights = new Map<string | null, number>([[null, 0]]);
    for (const spend of spending) {
      if (!routeMonths.includes(monthOf(spend.date))) continue;
      const route = spend.cardId !== null && cardById.has(spend.cardId) ? spend.cardId : null;
      routeWeights.set(route, (routeWeights.get(route) ?? 0) + spend.amountMinor);
    }
    const routeIds = [null, ...[...routeWeights.keys()].filter((id): id is string => id !== null).sort()];
    // With no recent spending every weight is zero and the whole share goes to
    // cash, the route that leaves soonest.
    const shares = splitByWeights(10_000, routeIds.map((id) => routeWeights.get(id) ?? 0));
    const routes = routeIds
      .map((cardId, index) => ({ cardId, shareBasisPoints: shares[index]! }))
      .filter((route) => route.shareBasisPoints > 0);

    for (const month of months) {
      const planned = plannedFor(budget, month);
      if (planned === null) continue;

      const spentMinor = spentByMonth.get(month) ?? 0;
      const inMonth = commitments.filter((commitment) => monthOf(commitment.date) === month);
      const committedMinor = inMonth.reduce((sum, commitment) => sum + commitment.amountMinor, 0);
      const remainingMinor = Math.max(0, planned - spentMinor - committedMinor);

      const from = month === currentMonth ? input.asOf : firstDay(month);
      const days: DateString[] = [];
      for (let day = from; day <= lastDay(month); day = addDaysIso(day, 1)) days.push(day);
      const dated = datedEvents(budget.id, month, remainingMinor, routes, days, cardById);
      result.events.push(...dated.events);
      result.cardCharges.push(...dated.cardCharges);

      // Reported per route from the events themselves, so the parts can never
      // disagree with what the forecast actually carries.
      const allocations = routes.map((route, index): RouteAllocation => {
        const own = dated.events.filter((event) => dated.routeOf.get(event.logicalKey) === index);
        return {
          cardId: route.cardId,
          shareBasisPoints: route.shareBasisPoints,
          // Events are outflows; subtracting them sums the magnitudes (and an
          // empty route is 0, not −0).
          amountMinor: own.reduce((sum, event) => sum - event.amountMinor, 0),
          beyondHorizonMinor: own
            .filter((event) => event.expectedAt > input.horizonEnd)
            .reduce((sum, event) => sum - event.amountMinor, 0),
          settlementDates:
            route.cardId === null
              ? [...new Set([own[0]?.expectedAt, own.at(-1)?.expectedAt].filter((date): date is string => !!date))]
              : own.map((event) => event.expectedAt),
        };
      });

      result.estimates.push({
        budgetId: budget.id,
        month,
        plannedMinor: planned,
        spentMinor,
        committedMinor,
        committedBySource: committedBySource(inMonth),
        remainingMinor,
        routes,
        allocations,
        beyondHorizonMinor: allocations.reduce((sum, allocation) => sum + allocation.beyondHorizonMinor, 0),
      });
    }
  }

  return result;
}

/** Groups a month's commitments by source, in order of first occurrence. */
function committedBySource(commitments: ConsumptionCommitment[]): CommittedBySource[] {
  const bySource = new Map<string, CommittedBySource>();
  const sorted = [...commitments].sort((left, right) => left.date.localeCompare(right.date));
  for (const commitment of sorted) {
    const kind = commitment.source?.kind ?? "other";
    const sourceId = commitment.source?.id ?? null;
    const key = `${kind}:${sourceId ?? ""}`;
    const entry = bySource.get(key);
    if (entry) {
      entry.occurrences += 1;
      entry.amountMinor += commitment.amountMinor;
      continue;
    }
    bySource.set(key, {
      kind,
      sourceId,
      label: commitment.source?.label ?? "unlabelled commitment",
      occurrences: 1,
      firstDate: commitment.date,
      amountMinor: commitment.amountMinor,
    });
  }
  return [...bySource.values()];
}

function datedEvents(
  budgetId: string,
  month: string,
  amountMinor: number,
  routes: ConsumptionRoute[],
  days: DateString[],
  cardById: Map<string, ConsumptionCard>,
): { events: ForecastEvent[]; cardCharges: BudgetCardCharge[]; routeOf: Map<string, number> } {
  const events: ForecastEvent[] = [];
  const cardCharges: BudgetCardCharge[] = [];
  /** Which route (index into `routes`) produced each event, by logical key. */
  const routeOf = new Map<string, number>();
  if (amountMinor <= 0 || days.length === 0) return { events, cardCharges, routeOf };
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
        routeOf.set(key, index);
        events.push({
          id: key,
          logicalKey: key,
          expectedAt: day,
          amountMinor: -perDay[dayIndex]!,
          sourceType: BUDGET_ESTIMATE_SOURCE,
          confidence: ESTIMATE_CONFIDENCE,
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
      if (perDay[dayIndex]! > 0) {
        cardCharges.push({ cardId: card.id, chargedAt: day, settlesAt: cycle.dueAt, amountMinor: perDay[dayIndex]! });
      }
      byStatement.set(cycle.statementMonth, entry);
    });
    for (const [statementMonth, entry] of byStatement) {
      if (entry.amountMinor <= 0) continue;
      const key = `budget:${budgetId}:${month}:card:${card.id}:${statementMonth}`;
      routeOf.set(key, index);
      events.push({
        id: key,
        logicalKey: key,
        expectedAt: entry.dueAt,
        amountMinor: -entry.amountMinor,
        sourceType: BUDGET_ESTIMATE_SOURCE,
        confidence: ESTIMATE_CONFIDENCE,
      });
    }
  });

  return { events, cardCharges, routeOf };
}
