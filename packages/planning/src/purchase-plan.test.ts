import { describe, expect, it } from "vitest";
import { simulatePurchasePlan, type PlanItemOption } from "./planning";

const forecastInput = {
  asOf: "2026-09-07",
  horizonEnd: "2026-12-31",
  balances: [{ accountId: "cash", amountMinor: 800_000, observedAt: "2026-09-07" }],
  events: [
    { id: "salary-09", logicalKey: "salary:2026-09", expectedAt: "2026-09-25", amountMinor: 900_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "salary-10", logicalKey: "salary:2026-10", expectedAt: "2026-10-25", amountMinor: 900_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "salary-11", logicalKey: "salary:2026-11", expectedAt: "2026-11-25", amountMinor: 900_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "salary-12", logicalKey: "salary:2026-12", expectedAt: "2026-12-23", amountMinor: 900_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
  ],
};

function cashItem(itemId: string, amountMinor: number, expectedAt: string, deadline?: string): PlanItemOption {
  return {
    itemId,
    label: itemId,
    deadline,
    option: {
      id: itemId,
      label: `${itemId} in full`,
      totalCostMinor: amountMinor,
      installments: 1,
      cashEvents: [
        {
          id: `${itemId}:1`,
          logicalKey: `plan:${itemId}:1`,
          expectedAt,
          amountMinor: -amountMinor,
          sourceType: "purchase_simulation",
          confidence: "CONFIRMED",
        },
      ],
    },
  };
}

function cardItem(
  itemId: string,
  amountMinor: number,
  months: string[],
  card: { cardId: string; label: string; creditLimitMinor: number; committedMinor: number },
): PlanItemOption {
  const per = Math.floor(amountMinor / months.length);
  return {
    itemId,
    label: itemId,
    option: {
      id: itemId,
      label: `${itemId} in ${months.length}x`,
      totalCostMinor: amountMinor,
      installments: months.length,
      card,
      cashEvents: months.map((expectedAt, index) => ({
        id: `${itemId}:${index + 1}`,
        logicalKey: `plan:${itemId}:${index + 1}`,
        expectedAt,
        amountMinor: -per,
        sourceType: "card_statement" as const,
        confidence: "CONFIRMED" as const,
      })),
    },
  };
}

describe("simulatePurchasePlan", () => {
  it("charges the whole basket against one forecast, not each item against a fresh one", () => {
    const result = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 100_000,
      items: [
        cashItem("floor", 190_000, "2026-09-15"),
        cashItem("mattress", 100_000, "2026-09-15"),
        cashItem("doors", 179_000, "2026-09-15"),
      ],
    });

    expect(result.totalCostMinor).toBe(469_000);
    // 800_000 opening minus all three on the same day.
    expect(result.minimumBalanceAfterMinor).toBe(331_000);
    expect(result.minimumBalanceBeforeMinor).toBe(800_000);
    expect(result.feasible).toBe(true);
  });

  it("fails a basket whose items each fit alone but not together", () => {
    const alone = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 500_000,
      items: [cashItem("floor", 250_000, "2026-09-15")],
    });
    expect(alone.feasible).toBe(true);
    expect(alone.hardReserveViolated).toBe(false);

    const together = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 500_000,
      items: [
        cashItem("floor", 250_000, "2026-09-15"),
        cashItem("mattress", 250_000, "2026-09-15"),
      ],
    });
    expect(together.feasible).toBe(false);
    expect(together.hardReserveViolated).toBe(true);
    expect(together.rejections).toContain("HARD_RESERVE_VIOLATED");
  });

  it("sums one card's limit across every item charged to it", () => {
    const card = { cardId: "card-1", label: "Inter", creditLimitMinor: 300_000, committedMinor: 50_000 };
    const result = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      items: [
        cardItem("stroller", 240_000, ["2026-10-10", "2026-11-10"], card),
        cardItem("crib", 100_000, ["2026-10-10", "2026-11-10"], card),
      ],
    });

    const load = result.cards.find((entry) => entry.cardId === "card-1")!;
    expect(load.planChargedMinor).toBe(340_000);
    // 50_000 already committed + 340_000 charged against a 300_000 limit.
    expect(load.exceededMinor).toBe(90_000);
    expect(result.rejections).toContain("CREDIT_LIMIT_EXCEEDED");
    expect(result.feasible).toBe(false);
  });

  it("keeps two cards' limits independent", () => {
    const result = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      items: [
        cardItem("stroller", 240_000, ["2026-10-10"], {
          cardId: "card-1", label: "Inter", creditLimitMinor: 300_000, committedMinor: 0,
        }),
        cardItem("crib", 240_000, ["2026-10-10"], {
          cardId: "card-2", label: "Nubank", creditLimitMinor: 300_000, committedMinor: 0,
        }),
      ],
    });

    expect(result.cards).toHaveLength(2);
    expect(result.cards.every((entry) => entry.exceededMinor === 0)).toBe(true);
    expect(result.rejections).not.toContain("CREDIT_LIMIT_EXCEEDED");
  });

  it("rejects an item whose last payment lands after the plan's target date", () => {
    const result = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      targetDate: "2026-12-31",
      items: [
        cardItem("stroller", 240_000, ["2026-11-10", "2026-12-10", "2027-01-10"], {
          cardId: "card-1", label: "Inter", creditLimitMinor: 900_000, committedMinor: 0,
        }),
      ],
    });

    expect(result.rejections).toContain("DEADLINE_EXCEEDED");
    expect(result.items[0]!.rejections).toContain("DEADLINE_EXCEEDED");
    expect(result.feasible).toBe(false);
  });

  it("prefers an item's own deadline over the plan's target date", () => {
    const items = [cashItem("ac-install", 50_000, "2026-11-20", "2026-10-31")];
    const result = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      targetDate: "2026-12-31",
      items,
    });

    expect(result.items[0]!.rejections).toContain("DEADLINE_EXCEEDED");
  });

  it("refuses to silently drop an item that collides with another on logicalKey", () => {
    const duplicate = cashItem("floor", 190_000, "2026-09-15");
    expect(() =>
      simulatePurchasePlan({
        forecastInput,
        hardReserveMinor: 0,
        items: [duplicate, { ...duplicate, itemId: "floor-copy" }],
      }),
    ).toThrow(/collides/);
  });

  it("reports the plan's cash month by month", () => {
    const result = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      items: [
        cardItem("stroller", 240_000, ["2026-10-10", "2026-11-10"], {
          cardId: "card-1", label: "Inter", creditLimitMinor: 900_000, committedMinor: 0,
        }),
        cashItem("gypsum", 40_000, "2026-10-05"),
      ],
    });

    expect(result.monthlyImpactMinor["2026-10"]).toBe(160_000);
    expect(result.monthlyImpactMinor["2026-11"]).toBe(120_000);
  });
});

describe("monthlyOutlook", () => {
  it("reports, per month, what the plan takes out and what the balance does", () => {
    const result = simulatePurchasePlan({
      forecastInput,
      hardReserveMinor: 0,
      items: [
        cardItem("stroller", 240_000, ["2026-10-10", "2026-11-10"], {
          cardId: "card-1", label: "Inter", creditLimitMinor: 900_000, committedMinor: 0,
        }),
      ],
    });

    const october = result.monthlyOutlook.find((entry) => entry.month === "2026-10")!;
    expect(october.purchaseOutflowMinor).toBe(120_000);
    // The trough must be inside the month, never the whole horizon's.
    expect(october.minimumBalanceDate.startsWith("2026-10")).toBe(true);
    expect(october.minimumBalanceMinor).toBeLessThanOrEqual(october.closingBalanceMinor);

    const september = result.monthlyOutlook.find((entry) => entry.month === "2026-09")!;
    expect(september.purchaseOutflowMinor).toBe(0);

    // Every month in the horizon is present and in order.
    expect(result.monthlyOutlook[0]!.month).toBe("2026-09");
    const months = result.monthlyOutlook.map((entry) => entry.month);
    expect([...months].sort()).toEqual(months);
  });
});
