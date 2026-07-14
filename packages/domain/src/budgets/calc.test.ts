import { describe, expect, it } from "vitest";
import { budgetProgress, spentInPeriod } from "./calc";

describe("budgetProgress", () => {
  it("computes remaining and ratio", () => {
    const p = budgetProgress(100000, 40000);
    expect(p.remainingMinor).toBe(60000);
    expect(p.ratio).toBeCloseTo(0.4);
    expect(p.isOver).toBe(false);
    expect(p.isNearLimit).toBe(false);
  });
  it("flags near-limit at 90%", () => {
    expect(budgetProgress(100000, 95000).isNearLimit).toBe(true);
  });
  it("flags over-budget", () => {
    const p = budgetProgress(100000, 120000);
    expect(p.isOver).toBe(true);
    expect(p.remainingMinor).toBe(-20000);
  });
});

describe("spentInPeriod", () => {
  const txs = [
    { amountMinor: -5000, date: "2026-06-05", categoryId: "food", status: "posted", type: "expense" },
    { amountMinor: -3000, date: "2026-06-10", categoryId: "food", status: "imported", type: "expense" },
    { amountMinor: -9000, date: "2026-05-30", categoryId: "food", status: "posted", type: "expense" }, // outside window
    { amountMinor: -2000, date: "2026-06-12", categoryId: "rent", status: "posted", type: "expense" }, // other category
    { amountMinor: -1000, date: "2026-06-13", categoryId: "food", status: "rejected", type: "expense" }, // rejected
    { amountMinor: -4000, date: "2026-06-14", categoryId: "food", status: "posted", type: "transfer" }, // transfer
  ];
  it("sums only in-window, in-category expense outflows in ledger statuses", () => {
    expect(spentInPeriod(txs, new Set(["food"]), "2026-06-01", "2026-06-30")).toBe(8000);
  });

  it("does not mix currencies when a budget currency is provided", () => {
    const mixed = [
      { amountMinor: -5000, date: "2026-06-10", categoryId: "food", status: "posted", type: "expense", currencyCode: "INR" },
      { amountMinor: -9000, date: "2026-06-11", categoryId: "food", status: "posted", type: "expense", currencyCode: "USD" },
    ];
    expect(
      spentInPeriod(mixed, new Set(["food"]), "2026-06-01", "2026-06-30", "INR"),
    ).toBe(5000);
  });
});
