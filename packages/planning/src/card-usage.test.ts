import { describe, expect, it } from "vitest";
import type { ForecastEvent } from "@hermes-finance/forecast";
import { debtPaymentsFromForecast, peakCardUsage, type CardCharge } from "./card-usage";

const AS_OF = "2026-10-19";
const HORIZON_END = "2027-03-31";

function charge(chargedAt: string, settlesAt: string, amountMinor: number): CardCharge {
  return { cardId: "inter", chargedAt, settlesAt, amountMinor };
}

describe("peakCardUsage", () => {
  it("is today's debt when nothing new is charged", () => {
    const peak = peakCardUsage({
      asOf: AS_OF,
      horizonEnd: HORIZON_END,
      committedMinor: 958_252,
      debtPayments: [{ cardId: "inter", paidAt: "2026-11-07", amountMinor: 366_164 }],
      charges: [],
    });

    expect(peak).toEqual({ peakMinor: 958_252, peakDate: AS_OF });
  });

  it("frees the limit a paid statement held before the next purchase lands", () => {
    // The acceptance case: R$ 9.582,52 owed today, the R$ 3.661,64 statement
    // paid on 07/11, then a R$ 3.159 phone in 12x on 10/11.
    const phone = Array.from({ length: 12 }, (_unused, index) =>
      charge("2026-11-10", `2027-${String(index + 1).padStart(2, "0")}-07`, 26_325),
    );
    const peak = peakCardUsage({
      asOf: AS_OF,
      horizonEnd: HORIZON_END,
      committedMinor: 958_252,
      debtPayments: [{ cardId: "inter", paidAt: "2026-11-07", amountMinor: 366_164 }],
      charges: phone,
    });

    // On 10/11 the card holds 958 252 − 366 164 + 315 900 = 907 988, less than
    // today: summed instead, the phone would read as 1 274 152.
    expect(peak).toEqual({ peakMinor: 958_252, peakDate: AS_OF });
  });

  it("frees each instalment only when its own statement is paid", () => {
    const peak = peakCardUsage({
      asOf: AS_OF,
      horizonEnd: HORIZON_END,
      committedMinor: 0,
      debtPayments: [],
      charges: [
        charge("2026-11-01", "2026-12-07", 10_000),
        charge("2026-11-01", "2027-01-07", 10_000),
        // Bought after the first instalment was paid: 10 000 still open + 5 000.
        charge("2026-12-10", "2027-01-07", 5_000),
      ],
    });

    expect(peak).toEqual({ peakMinor: 20_000, peakDate: "2026-11-01" });
  });

  it("never lets a statement free more than the card owes", () => {
    // Statements carry bills and parcels charged after today; paying them must
    // not push usage below zero and hide a later purchase.
    const peak = peakCardUsage({
      asOf: AS_OF,
      horizonEnd: HORIZON_END,
      committedMinor: 10_000,
      debtPayments: [{ cardId: "inter", paidAt: "2026-11-07", amountMinor: 50_000 }],
      charges: [charge("2026-11-20", "2026-12-07", 30_000)],
    });

    expect(peak).toEqual({ peakMinor: 30_000, peakDate: "2026-11-20" });
  });

  it("charges a purchase dated in the past today, and ignores charges past the horizon", () => {
    const peak = peakCardUsage({
      asOf: AS_OF,
      horizonEnd: "2026-12-31",
      committedMinor: 0,
      debtPayments: [],
      charges: [charge("2026-10-01", "2026-11-07", 4_000), charge("2027-01-05", "2027-02-07", 99_000)],
    });

    expect(peak).toEqual({ peakMinor: 4_000, peakDate: AS_OF });
  });
});

describe("debtPaymentsFromForecast", () => {
  it("reads each statement settlement back to its card", () => {
    const events: ForecastEvent[] = [
      {
        id: "s1",
        logicalKey: "statement:6f2d3ac7-921c-4266-88df-9feb1f96753a:2026-10",
        expectedAt: "2026-11-07",
        amountMinor: -366_164,
        sourceType: "card_statement",
        confidence: "HIGH",
      },
      {
        id: "salary",
        logicalKey: "recurring:rule:salary:2026-11-07",
        expectedAt: "2026-11-07",
        amountMinor: 600_000,
        sourceType: "recurring_rule",
        confidence: "HIGH",
      },
    ];

    expect(debtPaymentsFromForecast(events)).toEqual([
      { cardId: "6f2d3ac7-921c-4266-88df-9feb1f96753a", paidAt: "2026-11-07", amountMinor: 366_164 },
    ]);
  });
});
