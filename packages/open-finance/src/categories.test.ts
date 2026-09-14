import { describe, expect, it } from "vitest";
import {
  isSameOwnerCategory,
  providerCategoryName,
  providerCategoryNames,
  TRANSFER_CATEGORY_NAME,
} from "./categories";

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

  it("does not call an investment label a movement on a credit card", () => {
    // Pluggy puts `Investments` on merchants that merely sound like one. You
    // cannot fund an investment position with a credit card, so on a card the
    // label says nothing, and a gap is more honest than a wrong transfer.
    expect(providerCategoryName("Investments", "credit")).toEqual({ kind: "unmapped" });
    expect(providerCategoryName("Investments", "bank")).toEqual({
      kind: "transfer",
      name: TRANSFER_CATEGORY_NAME,
    });
  });

  it("keeps the real movement labels on a card, where they do happen", () => {
    // A bill settlement really is seen on the card, and really is a movement.
    for (const category of ["Credit card payment", "Transfer - PIX", "Transfers"]) {
      expect(providerCategoryName(category, "credit")).toEqual({
        kind: "transfer",
        name: TRANSFER_CATEGORY_NAME,
      });
    }
  });

  it("reads a bank account when no kind is given", () => {
    expect(providerCategoryName("Investments")).toMatchObject({ kind: "transfer" });
  });

  it("a cash withdrawal is not evidence of a second leg", () => {
    // It is still labelled a movement, but it can never pair with anything:
    // your pocket is not an account here.
    expect(providerCategoryName("Same person transfer - CASH")).toMatchObject({
      kind: "transfer",
    });
    expect(isSameOwnerCategory("Same person transfer - CASH")).toBe(false);
    expect(isSameOwnerCategory("Same person transfer")).toBe(true);
  });
});
