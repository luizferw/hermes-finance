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

  it("labels a movement between the user's own accounts as one", () => {
    // Still not spending (R5), but named rather than blank: left uncategorized
    // it was the largest block in the breakdown and told the reader nothing.
    for (const transfer of [
      "Transfer - PIX",
      "Same person transfer",
      "Credit card payment",
      "Investments",
    ]) {
      expect(providerCategoryName(transfer)).toEqual({
        kind: "transfer",
        name: "Transferências",
      });
    }
  });

  it("keeps the movement distinguishable by kind, not by name", () => {
    // A report that excludes transfers should not have to know the label.
    expect(providerCategoryName("Transfer - PIX").kind).toBe("transfer");
    expect(providerCategoryName("Groceries").kind).toBe("category");
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

  it("includes the transfer label, since it is a real category now", () => {
    expect(providerCategoryNames()).toContain("Transferências");
    // The provider's individual transfer flavours never become categories.
    expect(providerCategoryNames()).not.toContain("PIX");
    expect(providerCategoryNames()).not.toContain("Same person transfer");
  });
});
