import { describe, expect, it } from "vitest";
import { parseQuickEntry } from "./parse";

const now = new Date(2026, 5, 25); // local 2026-06-25

describe("parseQuickEntry", () => {
  it("parses the canonical 'coffee 180 upi'", () => {
    expect(parseQuickEntry("coffee 180 upi", { now })).toEqual({
      description: "coffee",
      merchant: "coffee",
      amountMinor: 18000,
      type: "expense",
      method: "upi",
      categoryHint: null,
      accountHint: null,
      date: "2026-06-25",
    });
  });

  it("pulls #category, @account, and method in any order", () => {
    const r = parseQuickEntry("swiggy 450 #food @hdfc gpay", { now })!;
    expect(r.merchant).toBe("swiggy");
    expect(r.amountMinor).toBe(45000);
    expect(r.categoryHint).toBe("food");
    expect(r.accountHint).toBe("hdfc");
    expect(r.method).toBe("gpay");
  });

  it("handles ₹ symbol and Indian grouping glued to the amount", () => {
    expect(parseQuickEntry("rent ₹25,000 neft", { now })!.amountMinor).toBe(2500000);
  });

  it("detects income from keywords and keeps amount positive", () => {
    const r = parseQuickEntry("salary 90000 @icici", { now })!;
    expect(r.type).toBe("income");
    expect(r.amountMinor).toBe(9000000);
  });

  it("treats a negative/parenthesised amount as inflow", () => {
    expect(parseQuickEntry("refund (500)", { now })!.type).toBe("income");
  });

  it("shifts the date for 'yesterday'", () => {
    expect(parseQuickEntry("chai 20 cash yesterday", { now })!.date).toBe("2026-06-24");
  });

  it("returns null when there is no amount", () => {
    expect(parseQuickEntry("just some words", { now })).toBeNull();
    expect(parseQuickEntry("   ", { now })).toBeNull();
  });
});
