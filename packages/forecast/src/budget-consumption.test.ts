import { describe, expect, it } from "vitest";
import { buildForecast, type ForecastEvent } from "./forecast";
import {
  BUDGET_ESTIMATE_SOURCE,
  projectBudgetConsumption,
  type BudgetConsumptionInput,
  type ConsumptionSpend,
} from "./budget-consumption";

const AS_OF = "2026-10-19";
const GROCERIES = "cat-groceries";

function input(overrides: Partial<BudgetConsumptionInput> = {}): BudgetConsumptionInput {
  return {
    asOf: AS_OF,
    horizonEnd: "2026-10-31",
    // The ledger starts this month: no complete month of history yet.
    historyStart: "2026-10-01",
    budgets: [{ id: "market", categoryIds: [GROCERIES], plannedByMonth: { "2026-10": 85_000 } }],
    spending: [{ categoryId: GROCERIES, date: "2026-10-05", amountMinor: 51_348, cardId: null }],
    commitments: [],
    projectedParcels: [],
    cards: [],
    ...overrides,
  };
}

function total(events: ForecastEvent[]): number {
  return events.reduce((sum, event) => sum + event.amountMinor, 0);
}

function monthly(month: string, amountMinor: number, cardId: string | null = null): ConsumptionSpend {
  return { categoryId: GROCERIES, date: `${month}-10`, amountMinor, cardId };
}

describe("projectBudgetConsumption", () => {
  it("projects only what is left of the budget, never the whole budget again", () => {
    const result = projectBudgetConsumption(input());
    const [estimate] = result.estimates;

    expect(estimate).toMatchObject({
      month: "2026-10",
      plannedMinor: 85_000,
      spentMinor: 51_348,
      budgetRemainingMinor: 33_652,
      baseBasis: "budget",
      baseRemainingMinor: 33_652,
      conservativeRemainingMinor: 33_652,
      baseConfidence: "LOW",
    });
    expect(total(result.events.base)).toBe(-33_652);
    expect(total(result.events.conservative)).toBe(-33_652);
  });

  it("spreads the cash share over the days left in the month, in whole minor units", () => {
    const { events } = projectBudgetConsumption(input());
    const dates = events.base.map((event) => event.expectedAt);

    // 19th through 31st: thirteen days, nothing before today.
    expect(dates).toHaveLength(13);
    expect(dates[0]).toBe(AS_OF);
    expect(dates.at(-1)).toBe("2026-10-31");
    expect(events.base.every((event) => Number.isInteger(event.amountMinor) && event.amountMinor < 0)).toBe(true);
    expect(events.base.every((event) => event.sourceType === BUDGET_ESTIMATE_SOURCE)).toBe(true);
    // 33 652 / 13 = 2 588 rem 8: the leftover lands on the earliest days.
    expect(events.base[0]!.amountMinor).toBe(-2_589);
    expect(events.base.at(-1)!.amountMinor).toBe(-2_588);
  });

  it("subtracts what the forecast already projects in the category", () => {
    const result = projectBudgetConsumption(
      input({
        commitments: [
          { categoryId: GROCERIES, date: "2026-10-25", amountMinor: 10_000 },
          // Already past: a commitment before today is not ahead of anyone.
          { categoryId: GROCERIES, date: "2026-10-02", amountMinor: 99_999 },
          { categoryId: "cat-rent", date: "2026-10-25", amountMinor: 180_000 },
        ],
      }),
    );

    expect(result.estimates[0]!.committedMinor).toBe(10_000);
    expect(total(result.events.base)).toBe(-23_652);
  });

  it("subtracts parcels of past purchases in the month their statement books them", () => {
    const card = { id: "card-x", closingDay: 25, dueDay: 5 };
    const result = projectBudgetConsumption(
      input({
        horizonEnd: "2026-11-30",
        cards: [card],
        projectedParcels: [
          // Due 05/11: billed on October's statement, which closes on the 25th.
          { categoryId: GROCERIES, cardId: card.id, dueAt: "2026-11-05", amountMinor: 4_000 },
          // Due 05/12: November's statement.
          { categoryId: GROCERIES, cardId: card.id, dueAt: "2026-12-05", amountMinor: 4_000 },
          { categoryId: "cat-other", cardId: card.id, dueAt: "2026-12-05", amountMinor: 99_000 },
        ],
      }),
    );
    const committed = Object.fromEntries(result.estimates.map((estimate) => [estimate.month, estimate.committedMinor]));

    expect(committed).toEqual({ "2026-10": 4_000, "2026-11": 4_000 });
    expect(result.estimates[0]!.budgetRemainingMinor).toBe(85_000 - 51_348 - 4_000);
  });

  it("dates a parcel whose statement already closed today, so it is not lost", () => {
    const card = { id: "card-x", closingDay: 10, dueDay: 20 };
    const result = projectBudgetConsumption(
      input({
        cards: [card],
        // October's statement closed on the 10th, before today; not posted yet.
        projectedParcels: [{ categoryId: GROCERIES, cardId: card.id, dueAt: "2026-10-20", amountMinor: 4_000 }],
      }),
    );

    expect(result.estimates[0]!.committedMinor).toBe(4_000);
  });

  it("projects nothing for a budget already spent past its limit", () => {
    const result = projectBudgetConsumption(
      input({ spending: [{ categoryId: GROCERIES, date: "2026-10-05", amountMinor: 90_000, cardId: null }] }),
    );

    expect(result.estimates[0]!.budgetRemainingMinor).toBe(0);
    expect(result.events.base).toEqual([]);
    expect(result.events.conservative).toEqual([]);
  });

  it("bases the estimate on history once three complete months exist", () => {
    const result = projectBudgetConsumption(
      input({
        historyStart: "2026-01-01",
        spending: [
          monthly("2026-07", 60_000),
          monthly("2026-08", 90_000),
          monthly("2026-09", 70_000),
          { categoryId: GROCERIES, date: "2026-10-05", amountMinor: 51_348, cardId: null },
        ],
      }),
    );
    const [estimate] = result.estimates;

    expect(estimate).toMatchObject({
      historicalMonthlyMinor: 70_000,
      historyMonths: 3,
      baseBasis: "history",
      baseRemainingMinor: 18_652,
      baseConfidence: "MEDIUM",
      // The budget leaves more room than history uses; conservative keeps it.
      conservativeRemainingMinor: 33_652,
      conservativeConfidence: "LOW",
    });
    expect(total(result.events.base)).toBe(-18_652);
    expect(total(result.events.conservative)).toBe(-33_652);
  });

  it("never lets the conservative scenario be more optimistic than history", () => {
    const result = projectBudgetConsumption(
      input({
        historyStart: "2026-01-01",
        spending: [
          monthly("2026-07", 100_000),
          monthly("2026-08", 120_000),
          monthly("2026-09", 110_000),
          { categoryId: GROCERIES, date: "2026-10-05", amountMinor: 51_348, cardId: null },
        ],
      }),
    );

    expect(result.estimates[0]).toMatchObject({
      baseRemainingMinor: 58_652,
      conservativeRemainingMinor: 58_652,
      conservativeConfidence: "MEDIUM",
    });
  });

  it("does not count a month the ledger only partly covers as history", () => {
    const result = projectBudgetConsumption(
      input({
        historyStart: "2026-07-15",
        spending: [monthly("2026-08", 10_000), monthly("2026-09", 10_000)],
      }),
    );

    expect(result.estimates[0]).toMatchObject({ historyMonths: 2, historicalMonthlyMinor: null, baseBasis: "budget" });
  });

  it("sends the card share to the statement it would be billed on, as its own event", () => {
    const card = { id: "card-x", closingDay: 25, dueDay: 5 };
    const result = projectBudgetConsumption(
      input({
        cards: [card],
        spending: [
          // Three parts card to one part cash in the history window.
          monthly("2026-08", 30_000, card.id),
          monthly("2026-09", 10_000, null),
          { categoryId: GROCERIES, date: "2026-10-05", amountMinor: 51_348, cardId: null },
        ],
      }),
    );
    const cardEvents = result.events.base.filter((event) => event.logicalKey.includes(":card:"));
    const cashEvents = result.events.base.filter((event) => event.logicalKey.includes(":cash:"));

    expect(result.estimates[0]!.routes).toEqual([
      { cardId: null, shareBasisPoints: 2_500 },
      { cardId: card.id, shareBasisPoints: 7_500 },
    ]);
    expect(total(cardEvents)).toBe(-25_239);
    expect(total(cashEvents)).toBe(-8_413);
    // Days 19-25 close on October's statement, 26-31 on November's.
    expect(cardEvents.map((event) => [event.logicalKey, event.expectedAt])).toEqual([
      ["budget:market:2026-10:card:card-x:2026-10", "2026-11-05"],
      ["budget:market:2026-10:card:card-x:2026-11", "2026-12-05"],
    ]);
  });

  it("treats spending on a card that is no longer active as cash", () => {
    const result = projectBudgetConsumption(input({ spending: [monthly("2026-09", 10_000, "card-gone")] }));

    expect(result.estimates[0]!.routes).toEqual([{ cardId: null, shareBasisPoints: 10_000 }]);
  });

  it("carries the planned amount into next month and estimates the whole of it", () => {
    const result = projectBudgetConsumption(
      input({
        horizonEnd: "2026-11-30",
        commitments: [{ categoryId: GROCERIES, date: "2026-11-12", amountMinor: 5_000 }],
      }),
    );
    const november = result.estimates.find((estimate) => estimate.month === "2026-11")!;
    const novemberEvents = result.events.base.filter((event) => event.logicalKey.includes(":2026-11:"));

    expect(november).toMatchObject({ plannedMinor: 85_000, spentMinor: 0, committedMinor: 5_000 });
    expect(total(novemberEvents)).toBe(-80_000);
    expect(novemberEvents).toHaveLength(30);
    expect(novemberEvents[0]!.expectedAt).toBe("2026-11-01");
  });

  it("refuses to estimate a category that two budgets both claim", () => {
    const result = projectBudgetConsumption(
      input({
        budgets: [
          { id: "market", categoryIds: [GROCERIES], plannedByMonth: { "2026-10": 85_000 } },
          { id: "home", categoryIds: [GROCERIES, "cat-cleaning"], plannedByMonth: { "2026-10": 40_000 } },
          { id: "fun", categoryIds: ["cat-fun"], plannedByMonth: { "2026-10": 20_000 } },
        ],
      }),
    );

    expect(result.blockers).toEqual([
      { budgetId: "market", code: "CATEGORY_IN_MULTIPLE_BUDGETS", categoryId: GROCERIES },
      { budgetId: "home", code: "CATEGORY_IN_MULTIPLE_BUDGETS", categoryId: GROCERIES },
    ]);
    expect(result.estimates.map((estimate) => estimate.budgetId)).toEqual(["fun"]);
  });

  it("skips a budget with neither a planned amount nor history", () => {
    const result = projectBudgetConsumption(
      input({ budgets: [{ id: "empty", categoryIds: [GROCERIES], plannedByMonth: {} }] }),
    );

    expect(result.estimates).toEqual([]);
  });

  it("lowers the forecast trough by exactly the estimate and keeps every key unique", () => {
    const { events } = projectBudgetConsumption(input({ horizonEnd: "2026-11-30" }));
    const commitmentsOnly = buildForecast({
      asOf: AS_OF,
      horizonEnd: "2026-11-30",
      balances: [{ accountId: "bank", amountMinor: 500_000, observedAt: AS_OF }],
      events: [],
    });
    const withEstimate = buildForecast({
      asOf: AS_OF,
      horizonEnd: "2026-11-30",
      balances: [{ accountId: "bank", amountMinor: 500_000, observedAt: AS_OF }],
      events: events.base,
    });

    expect(new Set(events.base.map((event) => event.logicalKey)).size).toBe(events.base.length);
    expect(withEstimate.events).toHaveLength(events.base.length);
    expect(commitmentsOnly.minimumBalanceMinor - withEstimate.minimumBalanceMinor).toBe(-total(events.base));
  });

  it("rejects fractional or negative magnitudes", () => {
    expect(() =>
      projectBudgetConsumption(input({ commitments: [{ categoryId: GROCERIES, date: "2026-10-25", amountMinor: -1 }] })),
    ).toThrow(/positive magnitude/);
    expect(() =>
      projectBudgetConsumption(
        input({ spending: [{ categoryId: GROCERIES, date: "2026-10-05", amountMinor: 1.5, cardId: null }] }),
      ),
    ).toThrow(/integer minor units/);
  });
});
