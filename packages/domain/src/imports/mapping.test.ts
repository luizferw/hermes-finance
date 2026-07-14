import { describe, expect, it } from "vitest";
import { applyMapping, guessMapping } from "./mapping";

describe("guessMapping", () => {
  it("maps HDFC-style headers", () => {
    const mapping = guessMapping([
      "Date",
      "Narration",
      "Chq./Ref.No.",
      "Value Dt",
      "Withdrawal Amt.",
      "Deposit Amt.",
      "Closing Balance",
    ]);
    expect(mapping.date).toBe("Date");
    expect(mapping.description).toBe("Narration");
    expect(mapping.debit).toBe("Withdrawal Amt.");
    expect(mapping.credit).toBe("Deposit Amt.");
    expect(mapping.valueDate).toBe("Value Dt");
    expect(mapping.externalId).toBe("Chq./Ref.No.");
  });

  it("maps generic signed-amount exports", () => {
    const mapping = guessMapping(["Transaction Date", "Description", "Amount"]);
    expect(mapping.date).toBe("Transaction Date");
    expect(mapping.amount).toBe("Amount");
    expect(mapping.description).toBe("Description");
  });
});

describe("applyMapping", () => {
  const options = { currencyCode: "INR", dateFormat: "dd/MM/yyyy" };

  it("parses debit/credit pairs with debit as outflow", () => {
    const row = applyMapping(
      { Date: "05/01/2026", Narration: "UPI-SWIGGY", Debit: "450.00", Credit: "" },
      { date: "Date", description: "Narration", debit: "Debit", credit: "Credit" },
      options,
    );
    expect(row.error).toBeNull();
    expect(row.date).toBe("2026-01-05");
    expect(row.amountMinor).toBe(-45000);
  });

  it("parses credits as inflow", () => {
    const row = applyMapping(
      { Date: "01/01/2026", Narration: "SALARY", Debit: "", Credit: "1,50,000.00" },
      { date: "Date", description: "Narration", debit: "Debit", credit: "Credit" },
      options,
    );
    expect(row.amountMinor).toBe(15000000);
  });

  it("collects all errors instead of throwing", () => {
    const row = applyMapping(
      { Date: "garbage", Narration: "", Debit: "", Credit: "" },
      { date: "Date", description: "Narration", debit: "Debit", credit: "Credit" },
      options,
    );
    expect(row.error).toContain("Unrecognized date");
    expect(row.error).toContain("Neither debit nor credit");
    expect(row.error).toContain("Empty description");
  });

  it("respects the preferred date format for ambiguous dates", () => {
    const dayFirst = applyMapping(
      { d: "03/04/2026", n: "x", a: "1" },
      { date: "d", description: "n", amount: "a" },
      { currencyCode: "INR", dateFormat: "dd/MM/yyyy" },
    );
    expect(dayFirst.date).toBe("2026-04-03");
    const monthFirst = applyMapping(
      { d: "03/04/2026", n: "x", a: "1" },
      { date: "d", description: "n", amount: "a" },
      { currencyCode: "INR", dateFormat: "MM/dd/yyyy" },
    );
    expect(monthFirst.date).toBe("2026-03-04");
  });
});
