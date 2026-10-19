import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts,
  bills,
  budgetCategories,
  budgetPeriods,
  budgets,
  categories,
  creditCardPurchases,
  creditCards,
  db,
  installmentPlans,
  installments,
  transactions,
  users,
} from "@kosh/db";
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
 * that the forecast already projects. The ledger starts this month, so there
 * is no history and the budget is the basis.
 *
 * Card installments pin the parcel rule. Open Finance books one transaction
 * per parcel, so each parcel counts in the month it is billed — like Kosh's
 * own budget progress — and the parcels still projected on future statements
 * are spending already committed for their statement's month, not room for
 * the estimate. A purchase entered by hand is one full-value transaction; its
 * projected parcels never reach the ledger and must not be committed again.
 *
 * With a card closing on the 25th and due on the 5th, parcel N+1 of a plan
 * whose parcel N is on this month's statement is billed next month:
 *
 *   this month  spent     = 513,48 + 10 (parcel 1/3) + 7 (parcel 2/4) + 30 (by hand)
 *               committed = 100 (bill)
 *               estimate  = 850 − 560,48 − 100 = R$189,52
 *   next month  committed = 100 (bill) + 10 (parcel 2/3) + 7 (parcel 3/4)
 */
const stamp = randomUUID();
const userId = `budget_forecast_${stamp}`;
const PLANNED_MINOR = 85_000;
const SPENT_MINOR = 51_348;
const BILL_MINOR = 10_000;
const PARCEL_MINOR = 1_000;
const OLD_PARCEL_MINOR = 700;
const BY_HAND_MINOR = 3_000;
const SPENT_TOTAL_MINOR = SPENT_MINOR + PARCEL_MINOR + OLD_PARCEL_MINOR + BY_HAND_MINOR;
const REMAINING_MINOR = PLANNED_MINOR - SPENT_TOTAL_MINOR - BILL_MINOR;
const { start: monthStart, end: monthEnd } = monthRange(todayIso());
const currentMonth = monthStart.slice(0, 7);

/** The 5th of the month `offset` months after this one. */
function fifthOf(offset: number): string {
  const [year, month] = currentMonth.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(year, month - 1 + offset, 5));
  return date.toISOString().slice(0, 10);
}

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

  const [cardAccount] = await db
    .insert(accounts)
    .values({
      userId,
      name: `Card ${stamp}`,
      type: "credit_card",
      currencyCode: "INR",
      openingBalanceMinor: 0,
      currentBalanceMinor: -(PARCEL_MINOR + OLD_PARCEL_MINOR),
    })
    .returning({ id: accounts.id });
  const [card] = await db
    .insert(creditCards)
    .values({
      userId,
      accountId: cardAccount!.id,
      name: `Card ${stamp}`,
      currencyCode: "INR",
      creditLimitMinor: 1_000_000,
      defaultClosingDay: 25,
      defaultDueDay: 5,
    })
    .returning({ id: creditCards.id });

  // A card purchase and its plan. `linked` books the first parcel as the
  // transaction itself, the way the Open Finance sync does; otherwise the
  // transaction is a full-value purchase entered by hand.
  const bookPurchase = async (opts: { first: number; total: number; parcelMinor: number; linked: boolean }) => {
    const transactionMinor = opts.linked ? opts.parcelMinor : opts.parcelMinor * opts.total;
    const [row] = await db
      .insert(transactions)
      .values({
        userId,
        accountId: cardAccount!.id,
        type: "expense",
        date: monthStart,
        amountMinor: -transactionMinor,
        currencyCode: "INR",
        description: `Card purchase ${opts.first}/${opts.total}`,
        categoryId: groceries!.id,
      })
      .returning({ id: transactions.id });
    const [purchase] = await db
      .insert(creditCardPurchases)
      .values({ creditCardId: card!.id, transactionId: row!.id, purchaseDate: monthStart, totalAmountMinor: transactionMinor })
      .returning({ id: creditCardPurchases.id });
    const [plan] = await db
      .insert(installmentPlans)
      .values({ creditCardPurchaseId: purchase!.id, totalInstallments: opts.total, firstInstallmentNumber: opts.first })
      .returning({ id: installmentPlans.id });
    await db.insert(installments).values(
      Array.from({ length: opts.total - opts.first + 1 }, (_unused, index) => {
        const booked = opts.linked && index === 0;
        return {
          installmentPlanId: plan!.id,
          number: opts.first + index,
          amountMinor: opts.parcelMinor,
          // Parcel `first` is on this month's statement, due the 5th of next.
          expectedAt: fifthOf(index + 1),
          status: booked ? ("billed" as const) : ("projected" as const),
          transactionId: booked ? row!.id : null,
        };
      }),
    );
  };
  await bookPurchase({ first: 1, total: 3, parcelMinor: PARCEL_MINOR, linked: true });
  await bookPurchase({ first: 2, total: 4, parcelMinor: OLD_PARCEL_MINOR, linked: true });
  // Its parcel 1 would be billed this month too, but it is not booked.
  await bookPurchase({ first: 1, total: 3, parcelMinor: BY_HAND_MINOR / 3, linked: false });

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

    expect(total(estimates)).toBe(-REMAINING_MINOR);
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
      spentMinor: SPENT_TOTAL_MINOR,
      committedMinor: BILL_MINOR,
      budgetRemainingMinor: REMAINING_MINOR,
      baseBasis: "budget",
    });
    // The by-hand purchase's later parcels never reach the ledger: not committed.
    const next = estimates.find((estimate) => estimate.month !== currentMonth)!;
    expect(next).toMatchObject({ spentMinor: 0, committedMinor: BILL_MINOR + PARCEL_MINOR + OLD_PARCEL_MINOR });
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
