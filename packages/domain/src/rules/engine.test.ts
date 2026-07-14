import { describe, expect, it } from "vitest";
import {
  evaluateActions,
  extractMerchantToken,
  matchesRule,
  previewRule,
  suggestRules,
  type RuleTransaction,
} from "./engine";

const tx = (overrides: Partial<RuleTransaction> = {}): RuleTransaction => ({
  id: "t1",
  accountId: "a1",
  type: "expense",
  status: "imported",
  amountMinor: -45000,
  description: "Swiggy order",
  merchant: null,
  rawDescription: "UPI-SWIGGY-swiggy@icici-1234",
  narration: null,
  categoryId: null,
  ...overrides,
});

describe("matchesRule", () => {
  it("matches description case-insensitively", () => {
    expect(
      matchesRule(tx(), {
        matchAll: true,
        conditions: [{ field: "description_contains", value: "swiggy" }],
        actions: [],
      }),
    ).toBe(true);
  });

  it("matches raw import text", () => {
    expect(
      matchesRule(tx({ description: "Food" }), {
        matchAll: true,
        conditions: [{ field: "raw_text_contains", value: "swiggy@icici" }],
        actions: [],
      }),
    ).toBe(true);
  });

  it("compares amounts on absolute value in minor units", () => {
    const rule = (field: "amount_equals" | "amount_greater_than" | "amount_less_than", value: string) => ({
      matchAll: true,
      conditions: [{ field, value }],
      actions: [],
    });
    expect(matchesRule(tx(), rule("amount_equals", "45000"))).toBe(true);
    expect(matchesRule(tx(), rule("amount_greater_than", "40000"))).toBe(true);
    expect(matchesRule(tx(), rule("amount_less_than", "40000"))).toBe(false);
  });

  it("AND vs OR semantics", () => {
    const conditions = [
      { field: "description_contains" as const, value: "swiggy" },
      { field: "account_is" as const, value: "other-account" },
    ];
    expect(matchesRule(tx(), { matchAll: true, conditions, actions: [] })).toBe(false);
    expect(matchesRule(tx(), { matchAll: false, conditions, actions: [] })).toBe(true);
  });

  it("never matches with zero conditions", () => {
    expect(matchesRule(tx(), { matchAll: true, conditions: [], actions: [] })).toBe(false);
  });
});

describe("evaluateActions / previewRule", () => {
  it("builds a combined diff", () => {
    const diff = evaluateActions([
      { type: "set_category", value: "cat-food" },
      { type: "add_tag", value: "tag-1" },
      { type: "add_tag", value: "tag-2" },
      { type: "rename_merchant", value: "Swiggy" },
      { type: "mark_reviewed", value: null },
    ]);
    expect(diff).toEqual({
      setCategoryId: "cat-food",
      addTagIds: ["tag-1", "tag-2"],
      renameMerchant: "Swiggy",
      markReviewed: true,
    });
  });

  it("previews only matching transactions", () => {
    const preview = previewRule(
      [tx(), tx({ id: "t2", description: "Uber ride", rawDescription: null })],
      {
        matchAll: true,
        conditions: [{ field: "description_contains", value: "swiggy" }],
        actions: [{ type: "set_category", value: "cat-food" }],
      },
    );
    expect(preview.matchedCount).toBe(1);
    expect(preview.items[0]!.transactionId).toBe("t1");
  });
});

describe("merchant token + suggestions", () => {
  it("extracts merchant tokens from UPI narrations", () => {
    expect(extractMerchantToken("UPI-SWIGGY-swiggy@icici-99")).toBe("swiggy");
    expect(extractMerchantToken("POS 1234 AMAZON IN")).toBeNull();
    expect(extractMerchantToken("NEFT-ACME CORP SALARY")).toBe("acme");
  });

  it("suggests rules for repeated tokens with a dominant category", () => {
    const txs = [
      { description: "UPI-ZEPTO-1", categoryId: "groceries" },
      { description: "UPI-ZEPTO-2", categoryId: "groceries" },
      { description: "UPI-ZEPTO-3", categoryId: null },
      { description: "UPI-RANDOM-1", categoryId: null },
    ];
    const suggestions = suggestRules(txs, 3);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      token: "zepto",
      occurrences: 3,
      suggestedCategoryId: "groceries",
    });
  });
});
