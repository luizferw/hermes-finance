import { describe, expect, it } from "vitest";
import { calculateSpendingRoom, calculateSafeToSpend } from "./planning";

/**
 * A month that dips before payday and recovers after it: balance 1000 today,
 * a 500 bill on the 5th, 3000 of pay on the 10th, a 2000 statement on the 20th.
 */
const base = {
  asOf: "2026-01-01",
  horizonEnd: "2026-01-31",
  balances: [{ accountId: "a", amountMinor: 100000, observedAt: "2026-01-01" }],
  events: [
    { id: "b", logicalKey: "bill:1", expectedAt: "2026-01-05", amountMinor: -50000, sourceType: "bill", confidence: "HIGH" as const },
    { id: "p", logicalKey: "pay:1", expectedAt: "2026-01-10", amountMinor: 300000, sourceType: "recurring", confidence: "HIGH" as const },
    { id: "s", logicalKey: "stmt:1", expectedAt: "2026-01-20", amountMinor: -200000, sourceType: "card_statement", confidence: "HIGH" as const },
  ],
};

describe("calculateSpendingRoom", () => {
  it("settling today is the cash answer: every day is exposed", () => {
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 0, settlementDate: "2026-01-01" });
    const cash = calculateSafeToSpend({ forecastInput: base, hardReserveMinor: 0 });
    expect(room.spendingRoomMinor).toBe(cash.safeToSpendMinor);
    expect(room.troughDate).toBe("2026-01-05");
  });

  it("goes negative rather than reporting nothing to spend", () => {
    // The point of the figure: -2000 says next month lands two thousand below
    // the floor before anything new is bought. Flooring it at zero would erase
    // the only number that says how much trouble is already booked.
    const underwater = {
      ...base,
      balances: [{ accountId: "a", amountMinor: -250000, observedAt: "2026-01-01" }],
    };
    const room = calculateSpendingRoom({ forecastInput: underwater, hardReserveMinor: 0, settlementDate: "2026-01-20" });
    expect(room.spendingRoomMinor).toBeLessThan(0);
    expect(room.spendingRoomMinor).toBe(room.troughAfterSettlementMinor);
  });

  it("settling after the dip frees the money the dip was holding", () => {
    // The 5 January trough of 500 no longer constrains a charge due on the 20th;
    // what constrains it is the balance from the 20th onward.
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 0, settlementDate: "2026-01-20" });
    expect(room.troughMinor).toBe(50000);
    expect(room.troughAfterSettlementMinor).toBe(150000);
    expect(room.spendingRoomMinor).toBe(150000);
  });

  it("respects the hard reserve when the forecast is healthy", () => {
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 40000, settlementDate: "2026-01-20" });
    expect(room.floorMinor).toBe(40000);
    expect(room.spendingRoomMinor).toBe(150000 - 40000);
    expect(room.hardReserveViolated).toBe(false);
  });

  it("measures to the floor, so spending the room lands exactly on it", () => {
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 20000, settlementDate: "2026-01-20" });
    expect(room.floorMinor).toBe(20000);
    expect(room.troughAfterSettlementMinor - room.spendingRoomMinor).toBe(room.floorMinor);
  });

  it("reports the shortfall when the reserve is out of reach entirely", () => {
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 500000, settlementDate: "2026-01-20" });
    expect(room.hardReserveViolated).toBe(true);
    expect(room.spendingRoomMinor).toBe(150000 - 500000);
  });

  it("falls back to the horizon trough when settlement lands past it", () => {
    // Beyond the horizon nothing was modelled, so the honest bound is the same
    // one cash gets rather than a claim of unlimited room.
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 0, settlementDate: "2027-01-01" });
    expect(room.troughAfterSettlementMinor).toBe(room.troughMinor);
    expect(room.spendingRoomMinor).toBe(room.troughMinor);
  });

  it("rejects a malformed settlement date", () => {
    expect(() => calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 0, settlementDate: "20/01/2026" }))
      .toThrow(/settlementDate/);
  });
});
