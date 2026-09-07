import { describe, expect, it } from "vitest";
import { comparePaymentOptions, calculateSafeToSpend } from "./planning";

const forecastInput = {
  asOf: "2026-09-07",
  horizonEnd: "2026-10-31",
  balances: [{ accountId: "cash", amountMinor: 300_000, observedAt: "2026-09-07" }],
  events: [
    { id: "rent", logicalKey: "rent:2026-09", expectedAt: "2026-09-10", amountMinor: -180_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
    { id: "salary", logicalKey: "salary:2026-09", expectedAt: "2026-09-25", amountMinor: 750_000, sourceType: "recurring_rule", confidence: "CONFIRMED" as const },
  ],
};

describe("calculateSafeToSpend", () => {
  it("uses the minimum point in the curve, not the ending balance", () => {
    const result = calculateSafeToSpend({ forecastInput, hardReserveMinor: 150_000 });

    expect(result.safeToSpendMinor).toBe(0);
    expect(result.minimumBalanceMinor).toBe(120_000);
    expect(result.minimumBalanceDate).toBe("2026-09-10");
    expect(result.hardReserveViolated).toBe(true);
  });
});

describe("comparePaymentOptions", () => {
  it("rejects a cheaper cash option that violates the hard reserve and chooses the lowest-cost viable option", () => {
    const result = comparePaymentOptions({
      forecastInput: {
        ...forecastInput,
        balances: [{ accountId: "cash", amountMinor: 350_000, observedAt: "2026-09-07" }],
      },
      hardReserveMinor: 150_000,
      options: [
        {
          id: "pix",
          label: "PIX R$ 2.250",
          totalCostMinor: 225_000,
          cashEvents: [{ id: "pix", logicalKey: "purchase:stroller:pix", expectedAt: "2026-09-07", amountMinor: -225_000, sourceType: "purchase_simulation", confidence: "CONFIRMED" }],
        },
        {
          id: "five-installments",
          label: "5x R$ 500",
          totalCostMinor: 250_000,
          cashEvents: [
            { id: "five-1", logicalKey: "purchase:stroller:five:1", expectedAt: "2026-10-02", amountMinor: -50_000, sourceType: "card_statement", confidence: "CONFIRMED" },
            { id: "five-2", logicalKey: "purchase:stroller:five:2", expectedAt: "2026-10-30", amountMinor: -50_000, sourceType: "installment", confidence: "HIGH" },
          ],
        },
        {
          id: "ten-installments",
          label: "10x R$ 270",
          totalCostMinor: 270_000,
          cashEvents: [
            { id: "ten-1", logicalKey: "purchase:stroller:ten:1", expectedAt: "2026-10-02", amountMinor: -27_000, sourceType: "card_statement", confidence: "CONFIRMED" },
            { id: "ten-2", logicalKey: "purchase:stroller:ten:2", expectedAt: "2026-10-30", amountMinor: -27_000, sourceType: "installment", confidence: "HIGH" },
          ],
        },
      ],
    });

    expect(result.recommendedOptionId).toBe("five-installments");
    expect(result.options.find((option) => option.id === "pix")?.hardReserveViolated).toBe(true);
    expect(result.options.find((option) => option.id === "five-installments")?.hardReserveViolated).toBe(false);
  });
});
