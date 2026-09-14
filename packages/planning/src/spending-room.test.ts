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

  it("uses the existing trough as the floor once the reserve is already broken", () => {
    // The question being asked is "how much without being worse off than I am",
    // and measuring against a reserve the forecast already breaks answers zero
    // to everything — true, and useless.
    const underwater = {
      ...base,
      balances: [{ accountId: "a", amountMinor: -20000, observedAt: "2026-01-01" }],
    };
    const room = calculateSpendingRoom({ forecastInput: underwater, hardReserveMinor: 0, settlementDate: "2026-01-20" });
    expect(room.hardReserveViolated).toBe(true);
    expect(room.floorMinor).toBe(room.troughMinor);
    expect(room.spendingRoomMinor).toBeGreaterThan(0);
    // Spending exactly the room lands the later trough on the existing one.
    expect(room.troughAfterSettlementMinor - room.spendingRoomMinor).toBe(room.troughMinor);
  });

  it("keeps answering once the reserve is out of reach entirely", () => {
    // A reserve of 5000 that the forecast never approaches does not make every
    // answer zero; the floor becomes the trough and the question stays
    // answerable, with `hardReserveViolated` carrying the bad news.
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 500000, settlementDate: "2026-01-20" });
    expect(room.hardReserveViolated).toBe(true);
    expect(room.floorMinor).toBe(room.troughMinor);
    expect(room.spendingRoomMinor).toBe(100000);
  });

  it("never returns a negative room", () => {
    // Settlement on the trough day itself: nothing above the floor to spend.
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 50000, settlementDate: "2026-01-05" });
    expect(room.spendingRoomMinor).toBe(0);
  });

  it("falls back to the horizon trough when settlement lands past it", () => {
    // Beyond the horizon nothing was modelled, so the honest bound is the same
    // one cash gets rather than a claim of unlimited room.
    const room = calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 0, settlementDate: "2027-01-01" });
    const cash = calculateSafeToSpend({ forecastInput: base, hardReserveMinor: 0 });
    expect(room.troughAfterSettlementMinor).toBe(room.troughMinor);
    expect(room.spendingRoomMinor).toBe(cash.safeToSpendMinor);
  });

  it("rejects a malformed settlement date", () => {
    expect(() => calculateSpendingRoom({ forecastInput: base, hardReserveMinor: 0, settlementDate: "20/01/2026" }))
      .toThrow(/settlementDate/);
  });
});
