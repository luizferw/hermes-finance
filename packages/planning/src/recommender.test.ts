import { describe, expect, it } from "vitest";
import { comparePaymentOptions, monthlySettlementEvents, simulatePurchase } from "./planning";

/**
 * The PRD's mandatory end-to-end scenario: two accounts, a salary, rent, a
 * confirmed energy bill, internet, two card statements carrying installments,
 * and a R$1.500 hard reserve.
 */
const scenario = {
  asOf: "2026-09-07",
  horizonEnd: "2027-08-31",
  balances: [{ accountId: "consolidated", amountMinor: 750_000, observedAt: "2026-09-07" }],
  events: [
    { id: "rent-09", logicalKey: "rent:2026-09", expectedAt: "2026-09-10", amountMinor: -180_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "energy-09", logicalKey: "energy:2026-09", expectedAt: "2026-09-12", amountMinor: -26_382, sourceType: "imported_bill", confidence: "CONFIRMED" as const },
    { id: "internet-09", logicalKey: "internet:2026-09", expectedAt: "2026-09-15", amountMinor: -12_000, sourceType: "recurring_rule", confidence: "HIGH" as const },
    { id: "salary-09", logicalKey: "salary:2026-09", expectedAt: "2026-09-25", amountMinor: 750_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "inter-09", logicalKey: "statement:inter:2026-09", expectedAt: "2026-10-02", amountMinor: -243_000, sourceType: "card_statement", confidence: "CONFIRMED" as const },
  ],
};

const HARD_RESERVE = 150_000;

/** The stroller from the PRD: PIX R$2.250, 5x R$500 or 10x R$270. */
function strollerOptions(card?: { creditLimitMinor: number; committedMinor: number }) {
  return [
    {
      id: "pix",
      label: "PIX R$ 2.250",
      totalCostMinor: 225_000,
      installments: 1,
      cashEvents: monthlySettlementEvents({
        logicalKeyPrefix: "simulation:stroller:pix",
        sourceType: "purchase_simulation",
        firstPaymentDate: "2026-09-08",
        installments: 1,
        installmentAmountMinor: 225_000,
      }),
    },
    {
      id: "five",
      label: "5x R$ 500",
      totalCostMinor: 250_000,
      installments: 5,
      card: card ? { cardId: "inter", ...card } : undefined,
      cashEvents: monthlySettlementEvents({
        logicalKeyPrefix: "simulation:stroller:five",
        sourceType: "purchase_simulation",
        firstPaymentDate: "2026-10-02",
        installments: 5,
        installmentAmountMinor: 50_000,
      }),
    },
    {
      id: "ten",
      label: "10x R$ 270",
      totalCostMinor: 270_000,
      installments: 10,
      card: card ? { cardId: "inter", ...card } : undefined,
      cashEvents: monthlySettlementEvents({
        logicalKeyPrefix: "simulation:stroller:ten",
        sourceType: "purchase_simulation",
        firstPaymentDate: "2026-10-02",
        installments: 10,
        installmentAmountMinor: 27_000,
      }),
    },
  ];
}

describe("monthlySettlementEvents", () => {
  it("emits negative settlements that sum exactly to the total cost", () => {
    const events = monthlySettlementEvents({
      logicalKeyPrefix: "simulation:x",
      sourceType: "purchase_simulation",
      firstPaymentDate: "2026-10-02",
      installments: 3,
      installmentAmountMinor: 33_333,
      totalCostMinor: 100_000,
    });

    expect(events.map((event) => event.expectedAt)).toEqual(["2026-10-02", "2026-11-02", "2026-12-02"]);
    expect(events.reduce((total, event) => total + event.amountMinor, 0)).toBe(-100_000);
    expect(events.at(-1)!.amountMinor).toBe(-33_334);
  });

  it("clamps a month-end anchor rather than skipping a month", () => {
    const events = monthlySettlementEvents({
      logicalKeyPrefix: "simulation:y",
      sourceType: "purchase_simulation",
      firstPaymentDate: "2026-12-31",
      installments: 3,
      installmentAmountMinor: 10_000,
    });

    expect(events.map((event) => event.expectedAt)).toEqual(["2026-12-31", "2027-01-31", "2027-02-28"]);
  });

  it("rejects a zero or fractional installment count", () => {
    expect(() =>
      monthlySettlementEvents({ logicalKeyPrefix: "z", sourceType: "s", firstPaymentDate: "2026-10-02", installments: 0, installmentAmountMinor: 100 }),
    ).toThrow("positive integer");
  });
});

describe("comparePaymentOptions hard constraints", () => {
  it("recommends the cheapest option that preserves the hard reserve", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      options: strollerOptions(),
    });

    expect(result.status).toBe("OK");
    expect(result.recommendedOptionId).toBe("pix");
    expect(result.options.every((option) => option.feasible)).toBe(true);
  });

  it("drops an option to a card with no headroom left", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      options: strollerOptions({ creditLimitMinor: 300_000, committedMinor: 243_000 }),
    });

    const five = result.options.find((option) => option.id === "five")!;
    expect(five.feasible).toBe(false);
    expect(five.rejections).toContain("CREDIT_LIMIT_EXCEEDED");
    expect(five.creditLimitExceededMinor).toBe(193_000);
    // PIX carries no card constraint, so it survives and stays recommended.
    expect(result.recommendedOptionId).toBe("pix");
  });

  it("drops an option whose last installment lands after the deadline", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      maxLastPaymentDate: "2027-03-31",
      options: strollerOptions(),
    });

    const ten = result.options.find((option) => option.id === "ten")!;
    expect(ten.lastPaymentDate).toBe("2027-07-02");
    expect(ten.rejections).toEqual(["DEADLINE_EXCEEDED"]);
    expect(result.options.find((option) => option.id === "five")!.feasible).toBe(true);
  });

  it("reports NO_FEASIBLE_OPTION instead of inventing a recommendation", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: 900_000,
      options: strollerOptions(),
    });

    expect(result.status).toBe("NO_FEASIBLE_OPTION");
    expect(result.recommendedOptionId).toBeUndefined();
    expect(result.blockers).toHaveLength(3);
  });

  it("reports INSUFFICIENT_DATA when there is nothing to compare", () => {
    const result = comparePaymentOptions({ forecastInput: scenario, hardReserveMinor: HARD_RESERVE, options: [] });

    expect(result.status).toBe("INSUFFICIENT_DATA");
    expect(result.recommendedOptionId).toBeUndefined();
  });

  it("refuses an option that would drive the balance below the allowed floor", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: 0,
      minimumAllowedBalanceMinor: 0,
      options: [
        {
          id: "huge",
          label: "PIX R$ 9.000",
          totalCostMinor: 900_000,
          cashEvents: monthlySettlementEvents({
            logicalKeyPrefix: "simulation:huge",
            sourceType: "purchase_simulation",
            firstPaymentDate: "2026-09-08",
            installments: 1,
            installmentAmountMinor: 900_000,
          }),
        },
      ],
    });

    expect(result.options[0]!.rejections).toContain("NEGATIVE_BALANCE");
    expect(result.status).toBe("NO_FEASIBLE_OPTION");
  });
});

describe("comparePaymentOptions ranking and explanations", () => {
  it("warns about a soft goal without rejecting the option", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      softReserves: [{ id: "trip", name: "Viagem", amountMinor: 500_000 }],
      options: strollerOptions(),
    });

    const pix = result.options.find((option) => option.id === "pix")!;
    expect(pix.feasible).toBe(true);
    expect(pix.softReserveImpacts).toHaveLength(1);
    expect(pix.softReserveImpacts[0]!.name).toBe("Viagem");
    expect(pix.reasons.some((reason) => reason.includes("Viagem"))).toBe(true);
  });

  it("breaks a cost tie by liquidity, then by installment concentration", () => {
    const base = {
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
    };
    const result = comparePaymentOptions({
      ...base,
      options: [
        {
          id: "concentrated",
          label: "2x R$ 500 in one month",
          totalCostMinor: 100_000,
          installments: 2,
          cashEvents: [
            { id: "c1", logicalKey: "simulation:c:1", expectedAt: "2026-11-05", amountMinor: -50_000, sourceType: "purchase_simulation", confidence: "CONFIRMED" as const },
            { id: "c2", logicalKey: "simulation:c:2", expectedAt: "2026-11-20", amountMinor: -50_000, sourceType: "purchase_simulation", confidence: "CONFIRMED" as const },
          ],
        },
        {
          id: "spread",
          label: "2x R$ 500 across months",
          totalCostMinor: 100_000,
          installments: 2,
          cashEvents: monthlySettlementEvents({
            logicalKeyPrefix: "simulation:s",
            sourceType: "purchase_simulation",
            firstPaymentDate: "2026-11-05",
            installments: 2,
            installmentAmountMinor: 50_000,
          }),
        },
      ],
    });

    const concentrated = result.options.find((option) => option.id === "concentrated")!;
    const spread = result.options.find((option) => option.id === "spread")!;
    expect(concentrated.peakMonthlyOutflowMinor).toBe(100_000);
    expect(spread.peakMonthlyOutflowMinor).toBe(50_000);
    expect(result.recommendedOptionId).toBe("spread");
  });

  it("explains every verdict with the numbers behind it", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      options: strollerOptions({ creditLimitMinor: 1_000_000, committedMinor: 243_000 }),
    });

    for (const option of result.options) {
      expect(option.reasons.length).toBeGreaterThan(0);
      expect(option.reasons.some((reason) => reason.includes("hard reserve"))).toBe(true);
    }
    expect(result.options.find((option) => option.id === "five")!.reasons.some((reason) => reason.includes("card inter"))).toBe(true);
  });

  it("evaluates every option against the same snapshot", () => {
    const result = comparePaymentOptions({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      options: strollerOptions(),
    });

    const openings = new Set(result.options.map((option) => option.forecast.openingBalanceMinor));
    expect(openings).toEqual(new Set([750_000]));
  });
});

describe("simulatePurchase", () => {
  it("reports the immediate, monthly and trough impact of one option", () => {
    const [, five] = strollerOptions();
    const simulation = simulatePurchase({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      option: five!,
    });

    expect(simulation.installments).toBe(5);
    expect(simulation.immediateImpactMinor).toBe(50_000);
    expect(simulation.monthlyImpactMinor).toEqual({
      "2026-10": 50_000,
      "2026-11": 50_000,
      "2026-12": 50_000,
      "2027-01": 50_000,
      "2027-02": 50_000,
    });
    expect(simulation.lastPaymentDate).toBe("2027-02-02");
    expect(simulation.feasible).toBe(true);
    // The trough of this scenario is 2026-09-15, before salary and before the
    // first installment, so settlements that start in October cannot move it.
    expect(simulation.minimumBalanceDateAfter).toBe("2026-09-15");
    expect(simulation.minimumBalanceAfterMinor).toBe(simulation.minimumBalanceBeforeMinor);
    expect(simulation.safeToSpendAfterMinor).toBe(simulation.safeToSpendBeforeMinor);
  });

  it("lowers safe-to-spend when the purchase settles before the trough", () => {
    const [pix] = strollerOptions();
    const simulation = simulatePurchase({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      option: pix!,
    });

    expect(simulation.immediateImpactMinor).toBe(225_000);
    expect(simulation.minimumBalanceAfterMinor).toBe(simulation.minimumBalanceBeforeMinor - 225_000);
    expect(simulation.safeToSpendAfterMinor).toBe(simulation.safeToSpendBeforeMinor - 225_000);
  });

  it("reports card utilization after the purchase", () => {
    const [, five] = strollerOptions({ creditLimitMinor: 1_000_000, committedMinor: 243_000 });
    const simulation = simulatePurchase({
      forecastInput: scenario,
      hardReserveMinor: HARD_RESERVE,
      option: five!,
    });

    expect(simulation.cardUtilizationAfterMinor).toBe(493_000);
    expect(simulation.creditLimitExceededMinor).toBeUndefined();
  });

  it("marks an unaffordable purchase infeasible and says why", () => {
    const [pix] = strollerOptions();
    const simulation = simulatePurchase({
      forecastInput: scenario,
      hardReserveMinor: 700_000,
      option: pix!,
    });

    expect(simulation.feasible).toBe(false);
    expect(simulation.rejections).toContain("HARD_RESERVE_VIOLATED");
    expect(simulation.safeToSpendAfterMinor).toBe(0);
  });

  it("leaves the baseline untouched, so before and after share one snapshot", () => {
    const [pix] = strollerOptions();
    const eventsBefore = scenario.events.length;
    simulatePurchase({ forecastInput: scenario, hardReserveMinor: HARD_RESERVE, option: pix! });

    expect(scenario.events).toHaveLength(eventsBefore);
  });
});
