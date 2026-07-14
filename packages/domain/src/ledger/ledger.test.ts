import { describe, expect, it } from "vitest";
import { balanceDelta, runningBalances, validateSplits } from "./index";

describe("balanceDelta", () => {
  const transfer = {
    accountId: "src",
    transferAccountId: "dst",
    type: "transfer" as const,
    status: "posted" as const,
    amountMinor: -10000,
  };

  it("applies signed amount to the owning account", () => {
    expect(balanceDelta(transfer, "src")).toBe(-10000);
  });
  it("derives the destination side of transfers", () => {
    expect(balanceDelta(transfer, "dst")).toBe(10000);
  });
  it("ignores unrelated accounts and non-ledger statuses", () => {
    expect(balanceDelta(transfer, "other")).toBe(0);
    expect(balanceDelta({ ...transfer, status: "rejected" }, "src")).toBe(0);
    expect(balanceDelta({ ...transfer, status: "pending" }, "src")).toBe(0);
  });
});

describe("validateSplits", () => {
  it("accepts splits that sum to the total", () => {
    expect(
      validateSplits(-10000, [{ amountMinor: -4000 }, { amountMinor: -6000 }]),
    ).toEqual({ ok: true, differenceMinor: 0 });
  });
  it("reports the difference when unbalanced", () => {
    expect(validateSplits(-10000, [{ amountMinor: -4000 }])).toEqual({
      ok: false,
      differenceMinor: -6000,
    });
  });
  it("rejects empty splits", () => {
    expect(validateSplits(0, []).ok).toBe(false);
  });
});

describe("runningBalances", () => {
  it("accumulates per-day deltas from an opening balance", () => {
    const series = runningBalances("a", 100000, [
      { accountId: "a", type: "expense", status: "posted", amountMinor: -20000, date: "2026-01-02" },
      { accountId: "a", type: "income", status: "posted", amountMinor: 50000, date: "2026-01-01" },
      { accountId: "a", type: "expense", status: "rejected", amountMinor: -99999, date: "2026-01-03" },
    ]);
    expect(series).toEqual([
      { date: "2026-01-01", balanceMinor: 150000 },
      { date: "2026-01-02", balanceMinor: 130000 },
    ]);
  });
});
