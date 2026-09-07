import { describe, expect, it } from "vitest";
import { buildForecast } from "./forecast";

const baseInput = {
  asOf: "2026-09-07",
  horizonEnd: "2026-10-02",
  balances: [
    { accountId: "santander", amountMinor: 450_000, observedAt: "2026-09-07" },
    { accountId: "inter", amountMinor: 300_000, observedAt: "2026-09-07" },
  ],
};

describe("buildForecast", () => {
  it("produces a deterministic daily cash trajectory using integer minor units", () => {
    const forecast = buildForecast({
      ...baseInput,
      events: [
        { id: "rent", logicalKey: "rent:2026-09", expectedAt: "2026-09-10", amountMinor: -180_000, sourceType: "recurring_rule", confidence: "CONFIRMED" },
        { id: "salary", logicalKey: "salary:2026-09", expectedAt: "2026-09-25", amountMinor: 750_000, sourceType: "recurring_rule", confidence: "CONFIRMED" },
        { id: "internet", logicalKey: "internet:2026-09", expectedAt: "2026-09-15", amountMinor: -12_000, sourceType: "recurring_rule", confidence: "HIGH" },
      ],
    });

    expect(forecast.days.find((day) => day.date === "2026-09-10")?.closingBalanceMinor).toBe(570_000);
    expect(forecast.days.find((day) => day.date === "2026-09-25")?.closingBalanceMinor).toBe(1_308_000);
    expect(forecast.minimumBalanceMinor).toBe(558_000);
    expect(forecast.minimumBalanceDate).toBe("2026-09-15");
  });

  it("keeps only the best known event for a logical commitment and drops resolved projections", () => {
    const forecast = buildForecast({
      ...baseInput,
      horizonEnd: "2026-09-15",
      events: [
        { id: "estimate", logicalKey: "energy:2026-09", expectedAt: "2026-09-12", amountMinor: -24_730, sourceType: "historical_average", confidence: "LOW" },
        { id: "confirmed", logicalKey: "energy:2026-09", expectedAt: "2026-09-12", amountMinor: -26_382, sourceType: "imported_bill", confidence: "CONFIRMED" },
        { id: "paid-installment", logicalKey: "installment:renner:3", expectedAt: "2026-09-12", amountMinor: -30_000, sourceType: "installment", confidence: "ACTUAL" },
        { id: "duplicate-installment", logicalKey: "installment:renner:3", expectedAt: "2026-09-12", amountMinor: -30_000, sourceType: "installment", confidence: "HIGH", resolvedByTransactionId: "paid-installment" },
      ],
    });

    expect(forecast.events.map((event) => event.id)).toEqual(["confirmed", "paid-installment"]);
    expect(forecast.days.find((day) => day.date === "2026-09-12")?.outflowsMinor).toBe(56_382);
  });

  it("does not change consolidated cash for a transfer represented by matching legs", () => {
    const forecast = buildForecast({
      ...baseInput,
      horizonEnd: "2026-09-08",
      events: [
        { id: "transfer-out", logicalKey: "transfer:1:out", expectedAt: "2026-09-08", amountMinor: -50_000, sourceType: "transfer", confidence: "ACTUAL" },
        { id: "transfer-in", logicalKey: "transfer:1:in", expectedAt: "2026-09-08", amountMinor: 50_000, sourceType: "transfer", confidence: "ACTUAL" },
      ],
    });

    expect(forecast.days.at(-1)?.closingBalanceMinor).toBe(750_000);
  });
});
