import { describe, expect, it } from "vitest";
import { parseAskIntent } from "./intent";

describe("parseAskIntent", () => {
  it("classifies a category spending question for this month", () => {
    expect(parseAskIntent("show food spending this month")).toEqual({
      kind: "spending",
      period: "this_month",
      categoryQuery: "food",
    });
  });

  it("classifies a global spending question with no category", () => {
    expect(parseAskIntent("where did my money go")).toEqual({
      kind: "spending",
      period: "this_month",
      categoryQuery: null,
    });
  });

  it("reads last month", () => {
    expect(parseAskIntent("how much did i spend last month")?.kind).toBe("spending");
    expect(
      (parseAskIntent("how much did i spend last month") as { period: string }).period,
    ).toBe("last_month");
  });

  it("parses an amount threshold with grouping and ₹", () => {
    expect(parseAskIntent("find transactions above ₹5,000")).toEqual({
      kind: "find_above",
      amountMinor: 500000,
    });
  });

  it("classifies bills, pending, recurring, compare", () => {
    expect(parseAskIntent("what's due soon")?.kind).toBe("due_soon");
    expect(parseAskIntent("show pending entries")?.kind).toBe("pending");
    expect(parseAskIntent("show subscriptions")?.kind).toBe("recurring");
    expect(parseAskIntent("compare this month with last month")?.kind).toBe(
      "compare_months",
    );
  });

  it("resolves deterministic navigation", () => {
    expect(parseAskIntent("take me to imports")).toEqual({
      kind: "navigate",
      target: "imports",
    });
    expect(parseAskIntent("open accounts")?.kind).toBe("navigate");
  });

  it("returns null for a quick-entry / unknown command", () => {
    expect(parseAskIntent("coffee 180 upi")).toBeNull();
    expect(parseAskIntent("x")).toBeNull();
  });
});
