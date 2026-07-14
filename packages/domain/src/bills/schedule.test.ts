import { describe, expect, it } from "vitest";
import { advanceOnePeriod, billState, matchesBillPayment, rollDueDateForward } from "./schedule";

describe("billState", () => {
  const bill = { nextDueDate: "2026-06-15", recurrence: "monthly" as const, isActive: true };
  it("classifies overdue / due_soon / upcoming", () => {
    expect(billState(bill, "2026-06-20")).toBe("overdue");
    expect(billState(bill, "2026-06-10")).toBe("due_soon");
    expect(billState(bill, "2026-05-01")).toBe("upcoming");
    expect(billState({ ...bill, isActive: false }, "2026-06-20")).toBe("inactive");
  });
});

describe("due date math", () => {
  it("advances one period with end-of-month clamping", () => {
    expect(
      advanceOnePeriod({ nextDueDate: "2026-01-31", recurrence: "monthly", isActive: true }),
    ).toBe("2026-02-28");
  });
  it("rolls forward past today", () => {
    expect(
      rollDueDateForward(
        { nextDueDate: "2026-01-10", recurrence: "monthly", isActive: true },
        "2026-06-11",
      ),
    ).toBe("2026-07-10");
  });
});

describe("matchesBillPayment", () => {
  const bill = { expectedAmountMinor: 99900, nextDueDate: "2026-06-15" };
  it("matches outflows near the amount and date", () => {
    expect(matchesBillPayment(bill, { amountMinor: -99900, date: "2026-06-14" })).toBe(true);
    expect(matchesBillPayment(bill, { amountMinor: -105000, date: "2026-06-18" })).toBe(true);
  });
  it("rejects inflows, far amounts, far dates", () => {
    expect(matchesBillPayment(bill, { amountMinor: 99900, date: "2026-06-15" })).toBe(false);
    expect(matchesBillPayment(bill, { amountMinor: -200000, date: "2026-06-15" })).toBe(false);
    expect(matchesBillPayment(bill, { amountMinor: -99900, date: "2026-07-15" })).toBe(false);
  });
});
