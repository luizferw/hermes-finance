import { describe, expect, it } from "vitest";
import { providerCategoryName, providerCategoryNames } from "./categories";

describe("providerCategoryName", () => {
  it("translates the categories the provider actually sends", () => {
    expect(providerCategoryName("Groceries")).toEqual({ kind: "category", name: "Supermercado" });
    expect(providerCategoryName("Houseware")).toEqual({
      kind: "category",
      name: "Utensílios domésticos",
    });
    expect(providerCategoryName("Tax on financial operations")).toEqual({
      kind: "category",
      name: "IOF",
    });
  });

  it("refuses to categorize a movement between the user's own accounts", () => {
    // R5: a transfer is neither income nor expense, and categorizing one would
    // inflate every spending report with money that only changed place.
    for (const transfer of [
      "Transfer - PIX",
      "Same person transfer",
      "Credit card payment",
      "Investments",
    ]) {
      expect(providerCategoryName(transfer)).toEqual({ kind: "transfer" });
    }
  });

  it("separates a gap in the table from a deliberate refusal", () => {
    // A category Pluggy adds later reads as unmapped, which is reportable;
    // a transfer reads as transfer, which is not a gap.
    expect(providerCategoryName("Some Brand New Category")).toEqual({ kind: "unmapped" });
    expect(providerCategoryName(null)).toEqual({ kind: "unmapped" });
    expect(providerCategoryName("")).toEqual({ kind: "unmapped" });
  });
});

describe("providerCategoryNames", () => {
  it("lists every name the mapping can produce, without duplicates", () => {
    const names = providerCategoryNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("Supermercado");
    expect(names).toContain("Seguro de veículo");
  });

  it("never lists a transfer", () => {
    expect(providerCategoryNames()).not.toContain("PIX");
    expect(providerCategoryNames()).not.toContain("Transferências");
  });
});
