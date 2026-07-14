import { describe, expect, it } from "vitest";
import {
  computeConfidence,
  confidenceBand,
  type ConfidenceInput,
} from "./calc";

const base: ConfidenceInput = {
  liquidAssetsMinor: 0,
  avgMonthlySpendMinor: 0,
  incomeThisMonthMinor: 0,
  expenseThisMonthMinor: 0,
  budgetsTotal: 0,
  budgetsOver: 0,
  upcomingBillsTotalMinor: 0,
  billsOverdue: 0,
  goalsTotal: 0,
  goalsOnTrack: 0,
  inboxCount: 0,
};

describe("confidenceBand", () => {
  it("maps scores to bands", () => {
    expect(confidenceBand(90)).toBe("secure");
    expect(confidenceBand(70)).toBe("steady");
    expect(confidenceBand(50)).toBe("finding");
    expect(confidenceBand(20)).toBe("stretched");
  });
});

describe("computeConfidence", () => {
  it("drops factors that don't apply and renormalises weights", () => {
    // Only upkeep applies → its weight is 1, score == its score (100).
    const r = computeConfidence({ ...base, inboxCount: 0 });
    expect(r.factors.map((f) => f.key)).toEqual(["upkeep"]);
    expect(r.factors[0]!.weight).toBeCloseTo(1);
    expect(r.score).toBe(100);
  });

  it("a healthy financial picture lands secure", () => {
    const r = computeConfidence({
      ...base,
      liquidAssetsMinor: 6_000_00, // 6 months at 1L/mo
      avgMonthlySpendMinor: 1_000_00,
      incomeThisMonthMinor: 1_500_00,
      expenseThisMonthMinor: 1_000_00, // ~33% saved
      budgetsTotal: 3,
      budgetsOver: 0,
      upcomingBillsTotalMinor: 50_00,
      billsOverdue: 0,
      goalsTotal: 2,
      goalsOnTrack: 2,
      inboxCount: 0,
    });
    expect(r.band).toBe("secure");
    expect(r.weighing).toHaveLength(0);
    expect(r.onTop).toBe(true);
  });

  it("overdue bills and overspend pull confidence down and surface as weighing", () => {
    const r = computeConfidence({
      ...base,
      liquidAssetsMinor: 20_00,
      avgMonthlySpendMinor: 1_000_00, // ~0 months runway
      incomeThisMonthMinor: 1_000_00,
      expenseThisMonthMinor: 1_300_00, // overspending
      budgetsTotal: 3,
      budgetsOver: 3,
      upcomingBillsTotalMinor: 500_00,
      billsOverdue: 2,
      inboxCount: 40,
    });
    expect(r.score).toBeLessThan(42);
    expect(r.band).toBe("stretched");
    expect(r.weighing.length).toBeGreaterThan(0);
    expect(r.onTop).toBe(false);
    // Weakest factor sorts first.
    expect(r.weighing[0]!.score).toBeLessThanOrEqual(r.weighing.at(-1)!.score);
  });

  it("scores stay clamped to 0–100", () => {
    const r = computeConfidence({
      ...base,
      liquidAssetsMinor: 999_999_00,
      avgMonthlySpendMinor: 1_00,
      incomeThisMonthMinor: 100_00,
      expenseThisMonthMinor: 0,
    });
    for (const f of r.factors) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(100);
    }
    expect(r.score).toBeLessThanOrEqual(100);
  });
});
