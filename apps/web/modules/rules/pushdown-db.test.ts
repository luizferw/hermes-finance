import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, transactions, users } from "@kosh/db";
import { matchesRule, type RuleCondition } from "@kosh/domain";
import {
  candidateTransactions,
  previewRuleDefinition,
  type RuleDefinition,
} from "./engine";

/**
 * The rule engine narrows its scan with a SQL translation of the conditions
 * (see `ruleFilter`) but still judges each row in memory. These tests pin the
 * invariant that makes that safe: the SQL filter must never be narrower than
 * the real predicate, i.e. pushdown and a full in-memory scan agree exactly.
 */

let userId: string;
let everything: (typeof transactions.$inferSelect)[];

/** What `previewRuleDefinition` would find with no pushdown at all. */
function scanInMemory(definition: RuleDefinition): number {
  return everything.filter((tx) =>
    matchesRule(
      {
        id: tx.id,
        accountId: tx.accountId,
        type: tx.type,
        status: tx.status,
        amountMinor: tx.amountMinor,
        description: tx.description,
        merchant: tx.merchant,
        rawDescription: tx.rawDescription,
        narration: tx.narration,
        categoryId: tx.categoryId,
      },
      definition,
    ),
  ).length;
}

beforeAll(async () => {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "demo@kosh.local"))
    .limit(1);
  if (!u) throw new Error("seed demo user missing — run pnpm db:seed");
  userId = u.id;
  everything = await db.query.transactions.findMany({
    where: and(
      eq(transactions.userId, userId),
      isNull(transactions.deletedAt),
      inArray(transactions.status, ["pending", "imported", "reviewed", "posted"]),
    ),
  });
});

describe("condition pushdown matches a full in-memory scan", () => {
  const cases: Array<[string, boolean, RuleCondition[]]> = [
    ["substring on description/merchant", true, [
      { field: "description_contains", value: "a" },
    ]],
    ["substring is case-insensitive", true, [
      { field: "description_contains", value: "PAYMENT" },
    ]],
    ["LIKE wildcards stay literal", true, [
      { field: "description_contains", value: "100%_x" },
    ]],
    ["encrypted narration falls back to memory", true, [
      { field: "raw_text_contains", value: "a" },
    ]],
    ["OR with an unexpressible half still scans everything", false, [
      { field: "raw_text_contains", value: "a" },
      { field: "amount_greater_than", value: "100000" },
    ]],
    ["amount comparisons use absolute value", true, [
      { field: "amount_less_than", value: "-5000" },
    ]],
    ["amount equality", true, [{ field: "amount_equals", value: "50000" }]],
    ["a non-numeric amount matches nothing", true, [
      { field: "amount_equals", value: "abc" },
    ]],
    ["a non-uuid account matches nothing (and is not a cast error)", true, [
      { field: "account_is", value: "not-a-uuid" },
    ]],
    ["an unknown type matches nothing (and is not an enum error)", true, [
      { field: "transaction_type_is", value: "not-a-type" },
    ]],
    ["transaction type", true, [
      { field: "transaction_type_is", value: "expense" },
    ]],
    ["AND of several conditions", true, [
      { field: "transaction_type_is", value: "expense" },
      { field: "amount_greater_than", value: "1000" },
    ]],
    ["OR of several conditions", false, [
      { field: "transaction_type_is", value: "income" },
      { field: "description_contains", value: "a" },
    ]],
    ["a rule with no conditions matches nothing", true, []],
  ];

  it.each(cases)("%s", async (_name, matchAll, conditions) => {
    const definition: RuleDefinition = {
      matchAll,
      conditions,
      actions: [{ type: "mark_reviewed", value: null }],
    };
    const preview = await previewRuleDefinition(userId, definition);
    expect(preview.matchedCount).toBe(scanInMemory(definition));
    expect(preview.scannedCount).toBe(everything.length);
  });
});

it("keyset pagination yields every row exactly once across pages", async () => {
  const seen: string[] = [];
  // A batch far smaller than the row count, so the cursor loop runs many times.
  for await (const tx of candidateTransactions(userId, undefined, 7)) {
    seen.push(tx.id);
  }
  expect(seen.length).toBeGreaterThan(7);
  expect(new Set(seen).size).toBe(seen.length);
  expect(new Set(seen)).toEqual(new Set(everything.map((tx) => tx.id)));
});
