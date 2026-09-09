import { describe, expect, it } from "vitest";
import { recommendPurchasePlan, type PaymentOption, type RecommendationCandidateItem } from "./planning";

const forecastInput = {
  asOf: "2026-09-07",
  horizonEnd: "2027-06-30",
  balances: [{ accountId: "cash", amountMinor: 500_000, observedAt: "2026-09-07" }],
  events: [
    { id: "salary-09", logicalKey: "salary:2026-09", expectedAt: "2026-09-25", amountMinor: 600_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "salary-10", logicalKey: "salary:2026-10", expectedAt: "2026-10-25", amountMinor: 600_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "salary-11", logicalKey: "salary:2026-11", expectedAt: "2026-11-25", amountMinor: 600_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "salary-12", logicalKey: "salary:2026-12", expectedAt: "2026-12-23", amountMinor: 600_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
  ],
};

const CARD = { cardId: "inter", label: "Inter", creditLimitMinor: 1_000_000, committedMinor: 0 };

/** One settlement on `date`. */
function cash(itemId: string, amountMinor: number, date: string): PaymentOption {
  return {
    id: `${itemId}:cash`,
    label: `${itemId} in full`,
    totalCostMinor: amountMinor,
    installments: 1,
    cashEvents: [
      { id: `${itemId}:cash:1`, logicalKey: `plan:${itemId}:cash:1`, expectedAt: date, amountMinor: -amountMinor, sourceType: "purchase_simulation", confidence: "CONFIRMED" },
    ],
  };
}

/** `months.length` equal settlements on the given dates, charged to CARD. */
function card(itemId: string, amountMinor: number, months: string[], constraint = CARD): PaymentOption {
  const per = Math.floor(amountMinor / months.length);
  return {
    id: `${itemId}:card:${months.length}`,
    label: `${itemId} in ${months.length}x`,
    totalCostMinor: amountMinor,
    installments: months.length,
    card: constraint,
    cashEvents: months.map((expectedAt, index) => ({
      id: `${itemId}:card:${months.length}:${index + 1}`,
      logicalKey: `plan:${itemId}:card:${months.length}:${index + 1}`,
      expectedAt,
      amountMinor: -per,
      sourceType: "card_statement" as const,
      confidence: "CONFIRMED" as const,
    })),
  };
}

function item(
  itemId: string,
  candidates: PaymentOption[],
  extra: Partial<RecommendationCandidateItem> = {},
): RecommendationCandidateItem {
  return { itemId, label: itemId, candidates, ...extra };
}

describe("recommendPurchasePlan", () => {
  it("prefers the option that leaves the most cash, not the cheapest", () => {
    const result = recommendPurchasePlan({
      forecastInput,
      hardReserveMinor: 100_000,
      items: [
        item("floor", [
          cash("floor", 190_000, "2026-09-15"),
          card("floor", 200_000, ["2026-10-10", "2026-11-10", "2026-12-10"]),
        ]),
      ],
    });

    expect(result.status).toBe("OK");
    // The 3x costs 10_000 more in total and is still the recommendation,
    // because spreading it keeps the trough higher.
    expect(result.choices[0]!.optionId).toBe("floor:card:3");
    expect(result.choices[0]!.installments).toBe(3);
  });

  it("never recommends more installments than the item allows", () => {
    const result = recommendPurchasePlan({
      forecastInput,
      hardReserveMinor: 100_000,
      items: [
        item(
          "doors",
          [
            cash("doors", 179_000, "2026-09-15"),
            card("doors", 179_000, ["2026-10-10", "2026-11-10", "2026-12-10"]),
            card("doors", 179_000, ["2026-10-10", "2026-11-10", "2026-12-10", "2027-01-10", "2027-02-10", "2027-03-10"]),
          ],
          { maxInstallments: 3 },
        ),
      ],
    });

    expect(result.status).toBe("OK");
    expect(result.choices[0]!.installments).toBeLessThanOrEqual(3);
    expect(result.choices[0]!.optionId).toBe("doors:card:3");
  });

  it("falls back to paying in full when the item allows no installments", () => {
    const result = recommendPurchasePlan({
      forecastInput,
      hardReserveMinor: 100_000,
      items: [
        item(
          "gypsum",
          [
            cash("gypsum", 40_000, "2026-09-15"),
            card("gypsum", 40_000, ["2026-10-10", "2026-11-10", "2026-12-10"]),
          ],
          { maxInstallments: 1 },
        ),
      ],
    });

    expect(result.choices[0]!.installments).toBe(1);
    expect(result.choices[0]!.optionId).toBe("gypsum:cash");
  });

  it("reports that a cap makes an item impossible instead of quietly exceeding it", () => {
    const result = recommendPurchasePlan({
      forecastInput: {
        ...forecastInput,
        balances: [{ accountId: "cash", amountMinor: 50_000, observedAt: "2026-09-07" }],
      },
      hardReserveMinor: 40_000,
      items: [
        item(
          "piano",
          [
            cash("piano", 900_000, "2026-09-15"),
            card("piano", 900_000, ["2026-10-10", "2026-11-10", "2026-12-10", "2027-01-10", "2027-02-10", "2027-03-10"]),
          ],
          { maxInstallments: 1 },
        ),
      ],
    });

    expect(result.status).toBe("NO_FEASIBLE_PLAN");
    expect(result.blockers.join(" ")).toContain("cannot be split beyond 1x");
  });

  it("respects each item's deadline over the plan's target date", () => {
    const result = recommendPurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      targetDate: "2027-06-30",
      items: [
        item(
          "ac-install",
          [card("ac-install", 50_000, ["2026-10-10", "2026-11-10", "2026-12-10"])],
          { deadline: "2026-10-31" },
        ),
      ],
    });

    expect(result.status).toBe("NO_FEASIBLE_PLAN");
    expect(result.blockers.join(" ")).toContain("finishes after 2026-10-31");
  });

  it("spends one card's limit across items and stops when it runs out", () => {
    const tight = { cardId: "inter", label: "Inter", creditLimitMinor: 300_000, committedMinor: 0 };
    const result = recommendPurchasePlan({
      forecastInput: {
        ...forecastInput,
        balances: [{ accountId: "cash", amountMinor: 10_000, observedAt: "2026-09-07" }],
      },
      hardReserveMinor: 0,
      items: [
        item("stroller", [card("stroller", 240_000, ["2026-10-10", "2026-11-10"], tight)]),
        item("mattress", [card("mattress", 100_000, ["2026-10-10", "2026-11-10"], tight)]),
      ],
    });

    // The first fits on the card; the second cannot, and that is reported
    // rather than charged anyway.
    expect(result.status).toBe("NO_FEASIBLE_PLAN");
    expect(result.blockers.join(" ")).toContain("over its limit");
  });

  it("reports how far short a list falls without dropping any item", () => {
    const result = recommendPurchasePlan({
      forecastInput: {
        ...forecastInput,
        events: [],
        balances: [{ accountId: "cash", amountMinor: 100_000, observedAt: "2026-09-07" }],
      },
      hardReserveMinor: 80_000,
      items: [
        item("floor", [cash("floor", 190_000, "2026-09-15")]),
        item("mattress", [cash("mattress", 100_000, "2026-09-15")]),
      ],
    });

    expect(result.status).toBe("NO_FEASIBLE_PLAN");
    expect(result.shortfallMinor).toBeGreaterThan(0);
    expect(result.shortfallDate).toBe("2026-09-15");
    // No item was deferred or dropped to make the answer look better.
    expect(result.choices.length).toBeLessThan(2);
  });

  it("returns the basket verdict alongside the choices when everything fits", () => {
    const result = recommendPurchasePlan({
      forecastInput,
      hardReserveMinor: 50_000,
      targetDate: "2026-12-31",
      items: [
        item("gypsum", [cash("gypsum", 40_000, "2026-09-15")]),
        item("mattress", [card("mattress", 100_000, ["2026-10-10", "2026-11-10"])]),
      ],
    });

    expect(result.status).toBe("OK");
    expect(result.simulation).toBeDefined();
    expect(result.simulation!.totalCostMinor).toBe(140_000);
    expect(result.simulation!.feasible).toBe(true);
  });

  it("says so plainly when there is nothing to choose from", () => {
    const result = recommendPurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      items: [item("floor", [])],
    });

    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.choices).toEqual([]);
  });

  it("is deterministic — the same inputs in a different order give the same choices", () => {
    const items = [
      item("floor", [cash("floor", 40_000, "2026-09-15"), card("floor", 40_000, ["2026-10-10", "2026-11-10"])], { deadline: "2026-11-30" }),
      item("mattress", [cash("mattress", 30_000, "2026-09-15"), card("mattress", 30_000, ["2026-10-10", "2026-11-10"])], { deadline: "2026-10-31" }),
    ];
    const forward = recommendPurchasePlan({ forecastInput, hardReserveMinor: 0, items });
    const backward = recommendPurchasePlan({ forecastInput, hardReserveMinor: 0, items: [...items].reverse() });

    expect(backward.choices).toEqual(forward.choices);
  });
});
