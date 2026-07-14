/**
 * Rule engine. Pure: matching and action evaluation produce *diffs*;
 * persisting them (and writing audit logs) is the modules layer's job.
 * Every condition/action here is typed — no free-form query grammar.
 */

import type { TransactionType } from "../ledger";

export type RuleConditionField =
  | "description_contains"
  | "amount_equals"
  | "amount_greater_than"
  | "amount_less_than"
  | "account_is"
  | "raw_text_contains"
  | "transaction_type_is";

export type RuleActionType =
  | "set_category"
  | "add_tag"
  | "rename_merchant"
  | "mark_reviewed"
  | "assign_budget"
  | "link_bill";

export interface RuleCondition {
  field: RuleConditionField;
  value: string;
}

export interface RuleAction {
  type: RuleActionType;
  value: string | null;
}

export interface RuleLike {
  conditions: RuleCondition[];
  actions: RuleAction[];
  matchAll: boolean;
}

/** The slice of a transaction the rule engine can see. */
export interface RuleTransaction {
  id: string;
  accountId: string;
  type: TransactionType;
  status: string;
  amountMinor: number;
  description: string;
  merchant: string | null;
  rawDescription: string | null;
  narration: string | null;
  categoryId: string | null;
}

function matchesCondition(
  tx: RuleTransaction,
  condition: RuleCondition,
): boolean {
  const value = condition.value;
  switch (condition.field) {
    case "description_contains": {
      const needle = value.toLowerCase();
      return (
        tx.description.toLowerCase().includes(needle) ||
        (tx.merchant?.toLowerCase().includes(needle) ?? false)
      );
    }
    case "raw_text_contains": {
      const needle = value.toLowerCase();
      return (
        (tx.rawDescription?.toLowerCase().includes(needle) ?? false) ||
        (tx.narration?.toLowerCase().includes(needle) ?? false)
      );
    }
    case "amount_equals":
      return Math.abs(tx.amountMinor) === Math.abs(Number(value));
    case "amount_greater_than":
      return Math.abs(tx.amountMinor) > Math.abs(Number(value));
    case "amount_less_than":
      return Math.abs(tx.amountMinor) < Math.abs(Number(value));
    case "account_is":
      return tx.accountId === value;
    case "transaction_type_is":
      return tx.type === value;
  }
}

export function matchesRule(tx: RuleTransaction, rule: RuleLike): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.matchAll
    ? rule.conditions.every((c) => matchesCondition(tx, c))
    : rule.conditions.some((c) => matchesCondition(tx, c));
}

/** What a rule would change on one transaction. All fields optional. */
export interface RuleDiff {
  setCategoryId?: string;
  addTagIds?: string[];
  renameMerchant?: string;
  markReviewed?: boolean;
  assignBudgetId?: string;
  linkBillId?: string;
}

export function evaluateActions(actions: RuleAction[]): RuleDiff {
  const diff: RuleDiff = {};
  for (const action of actions) {
    switch (action.type) {
      case "set_category":
        if (action.value) diff.setCategoryId = action.value;
        break;
      case "add_tag":
        if (action.value) {
          diff.addTagIds = [...(diff.addTagIds ?? []), action.value];
        }
        break;
      case "rename_merchant":
        if (action.value) diff.renameMerchant = action.value;
        break;
      case "mark_reviewed":
        diff.markReviewed = true;
        break;
      case "assign_budget":
        if (action.value) diff.assignBudgetId = action.value;
        break;
      case "link_bill":
        if (action.value) diff.linkBillId = action.value;
        break;
    }
  }
  return diff;
}

export interface RulePreviewItem {
  transactionId: string;
  diff: RuleDiff;
}

export interface RulePreview {
  matchedCount: number;
  items: RulePreviewItem[];
}

/** Dry-run a rule against a set of transactions. */
export function previewRule(
  transactions: RuleTransaction[],
  rule: RuleLike,
): RulePreview {
  const diff = evaluateActions(rule.actions);
  const items = transactions
    .filter((tx) => matchesRule(tx, rule))
    .map((tx) => ({ transactionId: tx.id, diff }));
  return { matchedCount: items.length, items };
}

/**
 * Suggest a rule from repeated descriptions among uncategorized imports:
 * if `minOccurrences`+ transactions share a normalized merchant token and a
 * category was used for that token before, propose description_contains →
 * set_category.
 */
export interface RuleSuggestion {
  token: string;
  occurrences: number;
  suggestedCategoryId: string | null;
}

export function suggestRules(
  transactions: Array<Pick<RuleTransaction, "description" | "categoryId">>,
  minOccurrences = 3,
): RuleSuggestion[] {
  const tokenCounts = new Map<string, { count: number; categories: Map<string, number> }>();
  for (const tx of transactions) {
    const token = extractMerchantToken(tx.description);
    if (!token) continue;
    const entry = tokenCounts.get(token) ?? { count: 0, categories: new Map() };
    entry.count += 1;
    if (tx.categoryId) {
      entry.categories.set(
        tx.categoryId,
        (entry.categories.get(tx.categoryId) ?? 0) + 1,
      );
    }
    tokenCounts.set(token, entry);
  }
  const suggestions: RuleSuggestion[] = [];
  for (const [token, entry] of tokenCounts) {
    if (entry.count < minOccurrences) continue;
    let suggestedCategoryId: string | null = null;
    let best = 0;
    for (const [categoryId, count] of entry.categories) {
      if (count > best) {
        best = count;
        suggestedCategoryId = categoryId;
      }
    }
    suggestions.push({ token, occurrences: entry.count, suggestedCategoryId });
  }
  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Pull a stable merchant-ish token out of a bank description, e.g.
 * "UPI-SWIGGY-swiggy@icici-..." -> "swiggy".
 */
export function extractMerchantToken(description: string): string | null {
  const cleaned = description
    .toLowerCase()
    .replace(/^((upi|neft|imps|rtgs|pos|ach|atm)[-/ ]+)+/i, "")
    .replace(/[0-9@].*$/, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const word = cleaned.split(" ")[0]!;
  return word.length >= 3 ? word : cleaned || null;
}
