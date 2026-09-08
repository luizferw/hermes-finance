import { describe, expect, it } from "vitest";
import { buildForecast } from "./forecast";
import {
  addStatementMonths,
  expandInstallmentTail,
  nominalCycleDueDates,
  nominalCycleFor,
  projectRecurrences,
  projectStatements,
  resolveProjectedEvents,
} from "./projections";

describe("projectRecurrences", () => {
  it("expands a monthly rule across the range and skips occurrences before it", () => {
    const events = projectRecurrences(
      [
        {
          id: "rent",
          sourceType: "recurring_rule",
          amountMinor: -180_000,
          interval: "monthly",
          startDate: "2026-07-10",
          confidence: "CONFIRMED",
        },
      ],
      { from: "2026-09-01", to: "2026-11-30" },
    );

    expect(events.map((event) => event.expectedAt)).toEqual(["2026-09-10", "2026-10-10", "2026-11-10"]);
    expect(events.every((event) => event.amountMinor === -180_000)).toBe(true);
    expect(events[0]!.logicalKey).toBe("recurring:rent:2026-09-10");
  });

  it("re-anchors a month-end rule instead of drifting after February", () => {
    const events = projectRecurrences(
      [
        {
          id: "card-fee",
          sourceType: "recurring_rule",
          amountMinor: -5_000,
          interval: "monthly",
          startDate: "2026-01-31",
          confidence: "HIGH",
        },
      ],
      { from: "2026-01-01", to: "2026-04-30" },
    );

    expect(events.map((event) => event.expectedAt)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("stops at the rule end date", () => {
    const events = projectRecurrences(
      [
        {
          id: "gym",
          sourceType: "recurring_rule",
          amountMinor: -9_900,
          interval: "monthly",
          startDate: "2026-09-05",
          endDate: "2026-10-31",
          confidence: "HIGH",
        },
      ],
      { from: "2026-09-01", to: "2026-12-31" },
    );

    expect(events.map((event) => event.expectedAt)).toEqual(["2026-09-05", "2026-10-05"]);
  });

  it("supports weekly and yearly cadences", () => {
    const weekly = projectRecurrences(
      [{ id: "w", sourceType: "recurring_rule", amountMinor: -1_000, interval: "weekly", startDate: "2026-09-01", confidence: "LOW" }],
      { from: "2026-09-01", to: "2026-09-22" },
    );
    const yearly = projectRecurrences(
      [{ id: "y", sourceType: "recurring_rule", amountMinor: -100_000, interval: "yearly", startDate: "2026-03-15", confidence: "HIGH" }],
      { from: "2026-01-01", to: "2028-12-31" },
    );

    expect(weekly.map((event) => event.expectedAt)).toEqual(["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"]);
    expect(yearly.map((event) => event.expectedAt)).toEqual(["2026-03-15", "2027-03-15", "2028-03-15"]);
  });

  it("rejects fractional amounts and impossible dates", () => {
    expect(() =>
      projectRecurrences(
        [{ id: "bad", sourceType: "recurring_rule", amountMinor: 12.5, interval: "monthly", startDate: "2026-09-01", confidence: "LOW" }],
        { from: "2026-09-01", to: "2026-09-30" },
      ),
    ).toThrow("integer minor units");
    expect(() =>
      projectRecurrences(
        [{ id: "bad", sourceType: "recurring_rule", amountMinor: -100, interval: "monthly", startDate: "2026-02-30", confidence: "LOW" }],
        { from: "2026-09-01", to: "2026-09-30" },
      ),
    ).toThrow("valid ISO date");
  });
});

describe("expandInstallmentTail", () => {
  it("projects only N+1..M for a plan already partially billed", () => {
    const tail = expandInstallmentTail({
      totalInstallments: 10,
      currentInstallmentNumber: 3,
      installmentAmountMinor: 30_000,
      currentStatementMonth: "2026-09",
    });

    expect(tail.map((item) => item.number)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(tail[0]!.statementMonth).toBe("2026-10");
    expect(tail.at(-1)!.statementMonth).toBe("2027-04");
  });

  it("projects the whole plan when nothing has been billed yet", () => {
    const tail = expandInstallmentTail({
      totalInstallments: 10,
      currentInstallmentNumber: 0,
      installmentAmountMinor: 30_000,
      currentStatementMonth: "2026-09",
    });

    expect(tail).toHaveLength(10);
    expect(tail[0]!.statementMonth).toBe("2026-10");
  });

  it("returns nothing for a 1x purchase or a finished plan", () => {
    expect(
      expandInstallmentTail({ totalInstallments: 1, currentInstallmentNumber: 1, installmentAmountMinor: 250_000, currentStatementMonth: "2026-09" }),
    ).toEqual([]);
    expect(
      expandInstallmentTail({ totalInstallments: 10, currentInstallmentNumber: 10, installmentAmountMinor: 30_000, currentStatementMonth: "2026-09" }),
    ).toEqual([]);
  });

  it("settles the rounding remainder on the last installment so the tail sums exactly", () => {
    // R$1.000,00 in 3x: 33333 + 33333 + 33334.
    const tail = expandInstallmentTail({
      totalInstallments: 3,
      currentInstallmentNumber: 0,
      installmentAmountMinor: 33_333,
      currentStatementMonth: "2026-09",
      totalAmountMinor: 100_000,
    });

    expect(tail.map((item) => item.amountMinor)).toEqual([33_333, 33_333, 33_334]);
    expect(tail.reduce((total, item) => total + item.amountMinor, 0)).toBe(100_000);
  });

  it("rejects an installment number beyond the plan length", () => {
    expect(() =>
      expandInstallmentTail({ totalInstallments: 3, currentInstallmentNumber: 4, installmentAmountMinor: 1_000, currentStatementMonth: "2026-09" }),
    ).toThrow("must not exceed");
  });
});

describe("addStatementMonths", () => {
  it("rolls over the year boundary", () => {
    expect(addStatementMonths("2026-11", 3)).toBe("2027-02");
    expect(addStatementMonths("2026-01", -1)).toBe("2025-12");
  });
});

describe("projectStatements", () => {
  const cycles = [
    { id: "cycle-sep", creditCardId: "inter", statementMonth: "2026-09", dueAt: "2026-10-02" },
    { id: "cycle-oct", creditCardId: "inter", statementMonth: "2026-10", dueAt: "2026-11-02" },
  ];

  it("emits one cash event per cycle at the due date, never one per installment", () => {
    const events = projectStatements(
      cycles,
      [
        { billingCycleId: "cycle-sep", amountMinor: 30_000 },
        { billingCycleId: "cycle-sep", amountMinor: 213_000 },
        { billingCycleId: "cycle-oct", amountMinor: 30_000 },
      ],
      { from: "2026-09-07", to: "2026-11-30" },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      logicalKey: "statement:inter:2026-09",
      expectedAt: "2026-10-02",
      amountMinor: -243_000,
      confidence: "HIGH",
    });
  });

  it("prefers the reconciled statement total over the sum of known charges", () => {
    const events = projectStatements(
      [{ ...cycles[0]!, confirmedTotalMinor: 250_000 }],
      [{ billingCycleId: "cycle-sep", amountMinor: 30_000 }],
      { from: "2026-09-07", to: "2026-11-30" },
    );

    expect(events[0]).toMatchObject({ amountMinor: -250_000, confidence: "CONFIRMED" });
  });

  it("skips cycles outside the range and cycles with nothing charged", () => {
    const events = projectStatements(cycles, [{ billingCycleId: "cycle-oct", amountMinor: 10_000 }], {
      from: "2026-09-07",
      to: "2026-10-31",
    });

    expect(events).toEqual([]);
  });

  it("keeps a paid statement out of the active forecast", () => {
    const events = projectStatements(
      [{ ...cycles[0]!, confirmedTotalMinor: 243_000, resolvedByTransactionId: "tx-1" }],
      [],
      { from: "2026-09-07", to: "2026-11-30" },
    );
    const forecast = buildForecast({
      asOf: "2026-09-07",
      horizonEnd: "2026-11-30",
      balances: [{ accountId: "inter", amountMinor: 300_000, observedAt: "2026-09-07" }],
      events,
    });

    expect(forecast.events).toEqual([]);
    expect(forecast.minimumBalanceMinor).toBe(300_000);
  });
});

describe("resolveProjectedEvents", () => {
  it("attaches the settling transaction so the projection leaves the active set", () => {
    const projected = projectRecurrences(
      [{ id: "energy", sourceType: "recurring_rule", amountMinor: -24_730, interval: "monthly", startDate: "2026-09-12", confidence: "MEDIUM" }],
      { from: "2026-09-01", to: "2026-10-31" },
    );
    const resolved = resolveProjectedEvents(projected, [
      { transactionId: "tx-energy-sep", logicalKey: "recurring:energy:2026-09-12" },
    ]);
    const forecast = buildForecast({
      asOf: "2026-09-07",
      horizonEnd: "2026-10-31",
      balances: [{ accountId: "inter", amountMinor: 300_000, observedAt: "2026-09-07" }],
      events: resolved,
    });

    expect(resolved[0]!.resolvedByTransactionId).toBe("tx-energy-sep");
    expect(forecast.events.map((event) => event.expectedAt)).toEqual(["2026-10-12"]);
  });

  it("leaves unmatched projections untouched", () => {
    const projected = projectRecurrences(
      [{ id: "internet", sourceType: "recurring_rule", amountMinor: -12_000, interval: "monthly", startDate: "2026-09-15", confidence: "HIGH" }],
      { from: "2026-09-01", to: "2026-09-30" },
    );

    expect(resolveProjectedEvents(projected, [])).toEqual(projected);
  });
});

describe("nominalCycleFor", () => {
  it("bills a purchase made before closing in the current statement", () => {
    // Closes on the 25th, due on the 2nd of the next month.
    expect(nominalCycleFor("2026-09-07", 25, 2)).toEqual({
      statementMonth: "2026-09",
      closesAt: "2026-09-25",
      dueAt: "2026-10-02",
    });
  });

  it("pushes a purchase made after closing into the next statement", () => {
    expect(nominalCycleFor("2026-09-26", 25, 2)).toEqual({
      statementMonth: "2026-10",
      closesAt: "2026-10-25",
      dueAt: "2026-11-02",
    });
  });

  it("keeps a purchase made on the closing day in the open statement", () => {
    expect(nominalCycleFor("2026-09-25", 25, 2).statementMonth).toBe("2026-09");
  });

  it("pays in the same month when the due day falls after the closing day", () => {
    expect(nominalCycleFor("2026-09-01", 5, 15)).toEqual({
      statementMonth: "2026-09",
      closesAt: "2026-09-05",
      dueAt: "2026-09-15",
    });
  });

  it("clamps a day-31 cycle to the length of the month", () => {
    expect(nominalCycleFor("2026-02-10", 31, 10).closesAt).toBe("2026-02-28");
  });

  it("rejects impossible closing and due days", () => {
    expect(() => nominalCycleFor("2026-09-07", 0, 2)).toThrow("closingDay");
    expect(() => nominalCycleFor("2026-09-07", 25, 32)).toThrow("dueDay");
  });
});

describe("nominalCycleDueDates", () => {
  it("returns one due date per installment, month by month", () => {
    expect(nominalCycleDueDates("2026-09-07", 25, 2, 5)).toEqual([
      "2026-10-02",
      "2026-11-02",
      "2026-12-02",
      "2027-01-02",
      "2027-02-02",
    ]);
  });

  it("starts one month later for a purchase made after closing", () => {
    expect(nominalCycleDueDates("2026-09-26", 25, 2, 3)).toEqual(["2026-11-02", "2026-12-02", "2027-01-02"]);
  });

  it("returns a single date for a 1x purchase", () => {
    expect(nominalCycleDueDates("2026-09-07", 25, 2, 1)).toEqual(["2026-10-02"]);
  });
});
