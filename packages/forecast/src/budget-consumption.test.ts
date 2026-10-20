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
      remainingMinor: 33_652,
    });
    expect(total(result.events)).toBe(-33_652);
    // A budget is a manual estimate.
    expect(result.events.every((event) => event.confidence === "LOW")).toBe(true);
  });

  it("spreads the cash share over the days left in the month, in whole minor units", () => {
    const { events } = projectBudgetConsumption(input());
    const dates = events.map((event) => event.expectedAt);

    // 19th through 31st: thirteen days, nothing before today.
    expect(dates).toHaveLength(13);
    expect(dates[0]).toBe(AS_OF);
    expect(dates.at(-1)).toBe("2026-10-31");
    expect(events.every((event) => Number.isInteger(event.amountMinor) && event.amountMinor < 0)).toBe(true);
    expect(events.every((event) => event.sourceType === BUDGET_ESTIMATE_SOURCE)).toBe(true);
    // 33 652 / 13 = 2 588 rem 8: the leftover lands on the earliest days.
    expect(events[0]!.amountMinor).toBe(-2_589);
    expect(events.at(-1)!.amountMinor).toBe(-2_588);
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
    expect(total(result.events)).toBe(-23_652);
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
    expect(result.estimates[0]!.remainingMinor).toBe(85_000 - 51_348 - 4_000);
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

    expect(result.estimates[0]!.remainingMinor).toBe(0);
    expect(result.events).toEqual([]);
  });

  it("sends the card share to the statement it would be billed on, as its own event", () => {
    const card = { id: "card-x", closingDay: 25, dueDay: 5 };
    const result = projectBudgetConsumption(
      input({
        cards: [card],
        spending: [
          // Three parts card to one part cash over the recent months.
          monthly("2026-08", 30_000, card.id),
          monthly("2026-09", 10_000, null),
          { categoryId: GROCERIES, date: "2026-10-05", amountMinor: 51_348, cardId: null },
        ],
      }),
    );
    const cardEvents = result.events.filter((event) => event.logicalKey.includes(":card:"));
    const cashEvents = result.events.filter((event) => event.logicalKey.includes(":cash:"));

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
    // The same money, day by day, for the card's limit: spent each day, freed
    // when the statement that event settles is paid.
    expect(result.cardCharges).toHaveLength(13);
    expect(total(cardEvents)).toBe(-result.cardCharges.reduce((sum, charge) => sum + charge.amountMinor, 0));
    expect(result.cardCharges[0]).toMatchObject({ cardId: card.id, chargedAt: AS_OF, settlesAt: "2026-11-05" });
    expect(result.cardCharges.at(-1)).toMatchObject({ chargedAt: "2026-10-31", settlesAt: "2026-12-05" });
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
    const novemberEvents = result.events.filter((event) => event.logicalKey.includes(":2026-11:"));

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

  it("never lets history raise the ceiling the budget sets", () => {
    const result = projectBudgetConsumption(
      input({
        spending: [
          monthly("2026-07", 200_000),
          monthly("2026-08", 200_000),
          monthly("2026-09", 200_000),
          { categoryId: GROCERIES, date: "2026-10-05", amountMinor: 51_348, cardId: null },
        ],
      }),
    );

    expect(result.estimates[0]!.remainingMinor).toBe(33_652);
  });

  it("skips a budget with no planned amount", () => {
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
      events: events,
    });

    expect(new Set(events.map((event) => event.logicalKey)).size).toBe(events.length);
    expect(withEstimate.events).toHaveLength(events.length);
    expect(commitmentsOnly.minimumBalanceMinor - withEstimate.minimumBalanceMinor).toBe(-total(events));
  });

  it("accounts for every unit of the remaining amount, reporting what settles past the horizon", () => {
    // The production case: Supermercado, 33 652 left on 20/10, paid mostly on
    // Inter (closes 30, due 7). Spending on 31/10 lands on November's
    // statement, due 07/12 — past a 30-day horizon. That share used to vanish
    // from the projection without a word.
    const inter = { id: "inter", closingDay: 30, dueDay: 7 };
    const santander = { id: "santander", closingDay: 2, dueDay: 10 };
    const scenario = (horizonEnd: string) =>
      input({
        asOf: "2026-10-20",
        horizonEnd,
        cards: [inter, santander],
        spending: [
          monthly("2026-08", 1_000, null),
          monthly("2026-08", 120_000, inter.id),
          monthly("2026-09", 6_000, santander.id),
          { categoryId: GROCERIES, date: "2026-10-05", amountMinor: 51_348, cardId: null },
        ],
      });
    const inHorizon = (events: ForecastEvent[], horizonEnd: string) =>
      events.filter((event) => event.expectedAt <= horizonEnd);

    const short = projectBudgetConsumption(scenario("2026-11-19"));
    const october = short.estimates[0]!;
    expect(october.remainingMinor).toBe(33_652);
    // The parts always add up to the whole, route by route.
    expect(october.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0)).toBe(33_652);
    const octoberEvents = short.events.filter((event) => event.logicalKey.includes(":2026-10:"));
    expect(total(octoberEvents)).toBe(-33_652);
    const interPart = october.allocations.find((allocation) => allocation.cardId === inter.id)!;
    expect(interPart.settlementDates).toEqual(["2026-11-07", "2026-12-07"]);
    // One day of twelve settles on 07/12.
    expect(interPart.beyondHorizonMinor).toBeGreaterThan(0);
    expect(october.beyondHorizonMinor).toBe(interPart.beyondHorizonMinor);
    expect(total(inHorizon(octoberEvents, "2026-11-19"))).toBe(-(33_652 - october.beyondHorizonMinor));
    // What the forecast over that horizon actually carries matches.
    const forecast = buildForecast({
      asOf: "2026-10-20",
      horizonEnd: "2026-11-19",
      balances: [{ accountId: "bank", amountMinor: 0, observedAt: "2026-10-20" }],
      events: octoberEvents,
    });
    expect(forecast.days.at(-1)!.closingBalanceMinor).toBe(-(33_652 - october.beyondHorizonMinor));

    // A horizon reaching October's due dates carries all of October; the last
    // month always spills onto a statement due after it, and says how much.
    const long = projectBudgetConsumption(scenario("2027-02-17"));
    expect(long.estimates[0]!.beyondHorizonMinor).toBe(0);
    for (const estimate of long.estimates) {
      const own = long.events.filter((event) => event.logicalKey.startsWith(`budget:market:${estimate.month}:`));
      expect(total(own)).toBe(-estimate.remainingMinor);
      expect(total(inHorizon(own, "2027-02-17"))).toBe(-(estimate.remainingMinor - estimate.beyondHorizonMinor));
    }
    expect(long.estimates.at(-1)!.beyondHorizonMinor).toBeGreaterThan(0);
  });

  it("takes committed apart by source, summing to committedMinor", () => {
    const card = { id: "card-x", closingDay: 25, dueDay: 5 };
    const result = projectBudgetConsumption(
      input({
        cards: [card],
        commitments: [
          { categoryId: GROCERIES, date: "2026-10-25", amountMinor: 10_000, source: { kind: "bill", id: "b1", label: "Feira" } },
          { categoryId: GROCERIES, date: "2026-10-28", amountMinor: 2_000, source: { kind: "recurring_rule", id: "r1", label: "Clube" } },
          { categoryId: GROCERIES, date: "2026-10-21", amountMinor: 3_000, source: { kind: "recurring_rule", id: "r1", label: "Clube" } },
          { categoryId: GROCERIES, date: "2026-10-30", amountMinor: 500 },
        ],
        projectedParcels: [
          { categoryId: GROCERIES, cardId: card.id, dueAt: "2026-11-05", amountMinor: 4_000, purchaseId: "p1", label: "Atacado" },
        ],
      }),
    );
    const october = result.estimates[0]!;

    expect(october.committedMinor).toBe(19_500);
    expect(october.committedBySource).toEqual([
      { kind: "recurring_rule", sourceId: "r1", label: "Clube", occurrences: 2, firstDate: "2026-10-21", amountMinor: 5_000 },
      { kind: "bill", sourceId: "b1", label: "Feira", occurrences: 1, firstDate: "2026-10-25", amountMinor: 10_000 },
      { kind: "card_parcel", sourceId: "p1", label: "Atacado", occurrences: 1, firstDate: "2026-10-25", amountMinor: 4_000 },
      { kind: "other", sourceId: null, label: "unlabelled commitment", occurrences: 1, firstDate: "2026-10-30", amountMinor: 500 },
    ]);
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
