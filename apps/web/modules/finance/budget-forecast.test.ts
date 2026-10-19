import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bills, budgetCategories, budgetPeriods, budgets, categories, db, transactions, users } from "@kosh/db";
import { BUDGET_ESTIMATE_SOURCE, type ForecastEvent } from "@hermes-finance/forecast";
import { monthRange, todayIso } from "@kosh/domain";
import {
  buildUserForecastDetailed,
  forecastForScenario,
  getBudgetForecast,
  getSafeToSpend,
  getUpcomingCommitments,
} from "./queries";

/**
 * Budgets reach the forecast as an estimate of what their categories still
 * have to spend, never as the whole budget again.
 *
 * The fixture is the acceptance case: a R$850 grocery budget with R$513,48
 * already spent leaves R$336,52 — less the R$100 bill in the same category
 * that the forecast already projects, so the estimate is R$236,52. The ledger
 * starts this month, so there is no history and the budget is the basis.
 */
const stamp = randomUUID();
const userId = `budget_forecast_${stamp}`;
const PLANNED_MINOR = 85_000;
const SPENT_MINOR = 51_348;
const BILL_MINOR = 10_000;
const { start: monthStart, end: monthEnd } = monthRange(todayIso());
const currentMonth = monthStart.slice(0, 7);

let budgetId: string;

function estimatesFor(events: ForecastEvent[], month: string): ForecastEvent[] {
  return events.filter(
    (event) => event.sourceType === BUDGET_ESTIMATE_SOURCE && event.logicalKey.startsWith(`budget:${budgetId}:${month}:`),
  );
}

function total(events: ForecastEvent[]): number {
  return events.reduce((sum, event) => sum + event.amountMinor, 0);
}

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Budget forecast probe", email: `${userId}@kosh.test` });
  const [bank] = await db
    .insert(accounts)
    .values({
      userId,
      name: `Bank ${stamp}`,
      type: "asset",
      currencyCode: "INR",
      openingBalanceMinor: 1_000_000,
      currentBalanceMinor: 1_000_000,
    })
    .returning({ id: accounts.id });
  const [groceries] = await db
    .insert(categories)
    .values({ userId, name: `Groceries ${stamp}` })
    .returning({ id: categories.id });

  const [budget] = await db.insert(budgets).values({ userId, name: "Groceries" }).returning({ id: budgets.id });
  budgetId = budget!.id;
  await db.insert(budgetCategories).values({ budgetId, categoryId: groceries!.id });
  await db.insert(budgetPeriods).values({
    budgetId,
    periodStart: monthStart,
    periodEnd: monthEnd,
    plannedAmountMinor: PLANNED_MINOR,
    currencyCode: "INR",
  });

  await db.insert(transactions).values([
    {
      userId,
      accountId: bank!.id,
      type: "expense",
      date: monthStart,
      amountMinor: -SPENT_MINOR,
      currencyCode: "INR",
      description: "Supermarket",
      categoryId: groceries!.id,
    },
    {
      // A soft-deleted duplicate is not spending.
      userId,
      accountId: bank!.id,
      type: "expense",
      date: monthStart,
      amountMinor: -SPENT_MINOR,
      currencyCode: "INR",
      description: "Supermarket (duplicate)",
      categoryId: groceries!.id,
      deletedAt: new Date(),
    },
  ]);

  await db.insert(bills).values({
    userId,
    name: "Grocery delivery club",
    expectedAmountMinor: BILL_MINOR,
    currencyCode: "INR",
    recurrence: "monthly",
    nextDueDate: monthEnd,
    accountId: bank!.id,
    categoryId: groceries!.id,
    amountStrategy: "fixed",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("budgets in the forecast", () => {
  it("projects what is left of the budget after spending and commitments, once", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 70);
    const estimates = estimatesFor(forecast.events, currentMonth);

    expect(total(estimates)).toBe(-(PLANNED_MINOR - SPENT_MINOR - BILL_MINOR));
    expect(estimates.every((event) => event.confidence === "LOW")).toBe(true);
    // The bill is still projected as itself, exactly once.
    const billEvents = forecast.events.filter((event) => event.sourceType === "bill");
    expect(billEvents.filter((event) => event.expectedAt === monthEnd).map((event) => event.amountMinor)).toEqual([
      -BILL_MINOR,
    ]);
  });

  it("explains each estimate with the figures it came from", async () => {
    const { estimates, blockers } = await getBudgetForecast(userId, 2);
    const current = estimates.find((estimate) => estimate.month === currentMonth)!;

    expect(blockers).toEqual([]);
    expect(current).toMatchObject({
      budgetName: "Groceries",
      plannedMinor: PLANNED_MINOR,
      spentMinor: SPENT_MINOR,
      committedMinor: BILL_MINOR,
      budgetRemainingMinor: PLANNED_MINOR - SPENT_MINOR - BILL_MINOR,
      baseBasis: "budget",
    });
  });

  it("keeps the commitments-only forecast one call away", async () => {
    const detailed = await buildUserForecastDetailed(userId, 70);
    const none = forecastForScenario(detailed, "none");

    expect(none.events.some((event) => event.sourceType === BUDGET_ESTIMATE_SOURCE)).toBe(false);
    expect(none.minimumBalanceMinor).toBeGreaterThan(detailed.forecast.minimumBalanceMinor);
  });

  it("does not list an estimate as something owed", async () => {
    const commitments = await getUpcomingCommitments(userId, 70);

    expect(commitments.some((commitment) => commitment.sourceType === BUDGET_ESTIMATE_SOURCE)).toBe(false);
    expect(commitments.some((commitment) => commitment.sourceType === "bill")).toBe(true);
  });

  it("reports safe-to-spend under every scenario, the estimate only ever lowering it", async () => {
    const result = await getSafeToSpend(userId, 70);

    expect(result.scenario).toBe("base");
    expect(result.safeToSpendMinor).toBe(result.safeToSpendByScenario.base);
    expect(result.estimatedVariableMinor).toBeGreaterThan(0);
    expect(result.safeToSpendByScenario.none).toBeGreaterThan(result.safeToSpendByScenario.base);
    expect(result.safeToSpendByScenario.base).toBeGreaterThanOrEqual(result.safeToSpendByScenario.conservative);
  });
});
