import { describe, expect, it } from "vitest";
import { formatMoney, majorToMinor, minorToMajor, parseAmountToMinor } from "./money";

describe("parseAmountToMinor", () => {
  it("parses plain decimals", () => {
    expect(parseAmountToMinor("1234.56", "INR")).toBe(123456);
    expect(parseAmountToMinor("0.01", "INR")).toBe(1);
    expect(parseAmountToMinor("500", "INR")).toBe(50000);
  });

  it("parses Indian grouping", () => {
    expect(parseAmountToMinor("1,23,456.78", "INR")).toBe(12345678);
    expect(parseAmountToMinor("12,500", "INR")).toBe(1250000);
  });

  it("parses negatives, parentheses and DR/CR suffixes", () => {
    expect(parseAmountToMinor("-1,234.50", "INR")).toBe(-123450);
    expect(parseAmountToMinor("(500.00)", "INR")).toBe(-50000);
    expect(parseAmountToMinor("1,000.00 DR", "INR")).toBe(-100000);
    expect(parseAmountToMinor("1,000.00 CR", "INR")).toBe(100000);
  });

  it("strips currency symbols and codes", () => {
    expect(parseAmountToMinor("₹ 1,234.56", "INR")).toBe(123456);
    expect(parseAmountToMinor("INR 99.00", "INR")).toBe(9900);
    expect(parseAmountToMinor("$12.34", "USD")).toBe(1234);
  });

  it("parses European decimal commas", () => {
    expect(parseAmountToMinor("1.234,56", "EUR")).toBe(123456);
    expect(parseAmountToMinor("12,50", "EUR")).toBe(1250);
  });

  it("handles zero-decimal currencies", () => {
    expect(parseAmountToMinor("1500", "JPY")).toBe(1500);
    expect(minorToMajor(1500, "JPY")).toBe(1500);
  });

  it("rejects garbage", () => {
    expect(parseAmountToMinor("", "INR")).toBeNull();
    expect(parseAmountToMinor("abc", "INR")).toBeNull();
    expect(parseAmountToMinor("12.34.56", "INR")).toBeNull();
  });
});

describe("formatMoney", () => {
  it("formats INR with lakh grouping when locale is en-IN", () => {
    expect(formatMoney(12345678, "INR", { locale: "en-IN" })).toBe("₹1,23,456.78");
  });
  it("drops decimals for whole amounts", () => {
    expect(formatMoney(120000, "INR", { locale: "en-IN" })).toBe("₹1,200");
  });
  it("can force a sign", () => {
    expect(formatMoney(50000, "INR", { locale: "en-IN", signDisplay: "always" })).toBe(
      "+₹500",
    );
    expect(formatMoney(-50000, "INR", { locale: "en-IN" })).toBe("-₹500");
  });

  it("defaults to a neutral en-US locale when none is given", () => {
    // Western 3-digit grouping, not Indian lakh grouping.
    expect(formatMoney(12345678, "INR")).toBe("₹123,456.78");
  });

  it("respects the user's locale for currency formatting (pt-BR)", () => {
    // Symbol after a non-breaking space, comma decimal separator, dot grouping.
    expect(formatMoney(750000, "BRL", { locale: "pt-BR", compactDecimals: false })).toBe(
      "R$ 7.500,00",
    );
  });

  it("respects the user's locale for currency formatting (en-IN)", () => {
    expect(formatMoney(750000, "INR", { locale: "en-IN" })).toBe("₹7,500");
  });
});

describe("major/minor conversion", () => {
  it("round-trips", () => {
    expect(majorToMinor(minorToMajor(123456, "INR"), "INR")).toBe(123456);
  });
  it("rounds half-up at the minor unit", () => {
    expect(majorToMinor(10.005, "INR")).toBe(1001);
  });
});
