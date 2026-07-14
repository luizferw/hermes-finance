import { describe, expect, it } from "vitest";
import { financialYearRange } from "./dates";

describe("financialYearRange", () => {
  it("India FY (April start): a date in-year maps to Apr–Mar", () => {
    expect(financialYearRange("2026-06-22", 4)).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
      label: "FY 2026–27",
    });
  });

  it("India FY: a date before April belongs to the previous FY", () => {
    expect(financialYearRange("2026-02-10", 4)).toEqual({
      start: "2025-04-01",
      end: "2026-03-31",
      label: "FY 2025–26",
    });
  });

  it("boundary: the first day of the FY", () => {
    const fy = financialYearRange("2026-04-01", 4);
    expect(fy.start).toBe("2026-04-01");
    expect(fy.end).toBe("2027-03-31");
  });

  it("calendar year (January start) labels with a single year", () => {
    expect(financialYearRange("2026-06-22", 1)).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
      label: "2026",
    });
  });

  it("July start (Pakistan/Bangladesh)", () => {
    expect(financialYearRange("2026-06-22", 7)).toEqual({
      start: "2025-07-01",
      end: "2026-06-30",
      label: "FY 2025–26",
    });
  });
});
