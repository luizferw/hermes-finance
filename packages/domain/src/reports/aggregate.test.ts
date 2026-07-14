import { describe, expect, it } from "vitest";
import { monthlyFlows, netWorthSeries, spendingByCategory } from "./aggregate";

describe("monthlyFlows", () => {
  it("groups income/expense by month, excluding transfers", () => {
    const flows = monthlyFlows([
      { date: "2026-05-01", amountMinor: 15000000, type: "income", status: "posted", categoryId: null },
      { date: "2026-05-12", amountMinor: -2000000, type: "expense", status: "posted", categoryId: "c1" },
      { date: "2026-05-20", amountMinor: -5000000, type: "transfer", status: "posted", categoryId: null },
      { date: "2026-06-01", amountMinor: 15000000, type: "income", status: "posted", categoryId: null },
      { date: "2026-06-02", amountMinor: -100, type: "expense", status: "rejected", categoryId: null },
    ]);
    expect(flows).toEqual([
      { month: "2026-05", incomeMinor: 15000000, expenseMinor: 2000000, netMinor: 13000000 },
      { month: "2026-06", incomeMinor: 15000000, expenseMinor: 0, netMinor: 15000000 },
    ]);
  });
});

describe("spendingByCategory", () => {
  it("sums absolute spend per category, sorted desc", () => {
    const spends = spendingByCategory(
      [
        { date: "2026-06-01", amountMinor: -100, type: "expense", status: "posted", categoryId: "a" },
        { date: "2026-06-02", amountMinor: -400, type: "expense", status: "posted", categoryId: "b" },
        { date: "2026-06-03", amountMinor: -200, type: "expense", status: "imported", categoryId: "a" },
        { date: "2026-06-04", amountMinor: -50, type: "expense", status: "posted", categoryId: null },
      ],
      "2026-06-01",
      "2026-06-30",
    );
    expect(spends).toEqual([
      { categoryId: "b", spentMinor: 400 },
      { categoryId: "a", spentMinor: 300 },
      { categoryId: null, spentMinor: 50 },
    ]);
  });
});

describe("netWorthSeries", () => {
  it("carries the latest balance per account forward", () => {
    const series = netWorthSeries([
      { accountId: "a", date: "2026-06-01", balanceMinor: 1000 },
      { accountId: "b", date: "2026-06-02", balanceMinor: 500 },
      { accountId: "a", date: "2026-06-03", balanceMinor: 1200 },
    ]);
    expect(series).toEqual([
      { date: "2026-06-01", netWorthMinor: 1000 },
      { date: "2026-06-02", netWorthMinor: 1500 },
      { date: "2026-06-03", netWorthMinor: 1700 },
    ]);
  });
});
