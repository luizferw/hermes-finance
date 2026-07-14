import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  automationRules,
  automationRuns,
  db,
  transactionTags,
  transactions,
} from "@kosh/db";
import {
  evaluateActions,
  matchesRule,
  type RuleAction,
  type RuleCondition,
  type RuleDiff,
  type RuleTransaction,
} from "@kosh/domain";
import { logAudit } from "@/modules/shared/audit";

export interface RuleDefinition {
  conditions: RuleCondition[];
  actions: RuleAction[];
  matchAll: boolean;
}

function toRuleTransaction(tx: typeof transactions.$inferSelect): RuleTransaction {
  return {
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
  };
}

/** Recent candidate transactions a rule could act on. */
async function candidateTransactions(userId: string, limit = 500) {
  return db.query.transactions.findMany({
    where: and(
      eq(transactions.userId, userId),
      isNull(transactions.deletedAt),
      inArray(transactions.status, ["pending", "imported", "reviewed", "posted"]),
    ),
    orderBy: [desc(transactions.date)],
    limit,
  });
}

export interface RulePreviewResult {
  matchedCount: number;
  scannedCount: number;
  sample: Array<{
    id: string;
    description: string;
    date: string;
    amountMinor: number;
    currencyCode: string;
    diff: RuleDiff;
  }>;
}

/** Dry-run a rule definition against recent transactions. */
export async function previewRuleDefinition(
  userId: string,
  definition: RuleDefinition,
): Promise<RulePreviewResult> {
  const candidates = await candidateTransactions(userId);
  const diff = evaluateActions(definition.actions);
  const matched = candidates.filter((tx) =>
    matchesRule(toRuleTransaction(tx), definition),
  );
  return {
    matchedCount: matched.length,
    scannedCount: candidates.length,
    sample: matched.slice(0, 8).map((tx) => ({
      id: tx.id,
      description: tx.description,
      date: tx.date,
      amountMinor: tx.amountMinor,
      currencyCode: tx.currencyCode,
      diff,
    })),
  };
}

/** Apply one diff to one transaction. Returns true if anything changed. */
async function applyDiff(
  tx: typeof transactions.$inferSelect,
  diff: RuleDiff,
): Promise<boolean> {
  const update: Partial<typeof transactions.$inferInsert> = {};
  if (diff.setCategoryId && diff.setCategoryId !== tx.categoryId) {
    update.categoryId = diff.setCategoryId;
  }
  if (diff.renameMerchant && diff.renameMerchant !== tx.merchant) {
    update.merchant = diff.renameMerchant;
  }
  if (
    diff.markReviewed &&
    (tx.status === "imported" || tx.status === "pending")
  ) {
    update.status = "reviewed";
  }
  if (diff.linkBillId && diff.linkBillId !== tx.billId) {
    update.billId = diff.linkBillId;
  }

  let changed = false;
  if (Object.keys(update).length > 0) {
    await db.update(transactions).set(update).where(eq(transactions.id, tx.id));
    changed = true;
  }
  if (diff.addTagIds?.length) {
    await db
      .insert(transactionTags)
      .values(diff.addTagIds.map((tagId) => ({ transactionId: tx.id, tagId })))
      .onConflictDoNothing();
    changed = true;
  }
  return changed;
}

/**
 * Execute a stored rule against transactions (all recent, or a given set).
 * Records an automation run and audit entry.
 */
export async function executeStoredRule(
  userId: string,
  ruleId: string,
  trigger: "manual" | "import",
  transactionIds?: string[],
): Promise<{ matched: number; applied: number }> {
  const rule = await db.query.automationRules.findFirst({
    where: and(eq(automationRules.id, ruleId), eq(automationRules.userId, userId)),
    with: { conditions: true, actions: true },
  });
  if (!rule) throw new Error("Rule not found");

  const definition: RuleDefinition = {
    matchAll: rule.matchAll,
    conditions: rule.conditions.map((c) => ({ field: c.field, value: c.value })),
    actions: rule.actions.map((a) => ({ type: a.type, value: a.value })),
  };

  const candidates = transactionIds
    ? await db.query.transactions.findMany({
        where: and(
          inArray(transactions.id, transactionIds),
          eq(transactions.userId, userId),
          isNull(transactions.deletedAt),
        ),
      })
    : await candidateTransactions(userId);

  const diff = evaluateActions(definition.actions);
  const startedAt = new Date();
  let matched = 0;
  let applied = 0;
  for (const tx of candidates) {
    if (!matchesRule(toRuleTransaction(tx), definition)) continue;
    matched += 1;
    if (await applyDiff(tx, diff)) applied += 1;
  }

  await db.insert(automationRuns).values({
    ruleId: rule.id,
    userId,
    trigger,
    matchedCount: matched,
    appliedCount: applied,
    startedAt,
    finishedAt: new Date(),
  });
  await logAudit({
    userId,
    action: "rule.executed",
    entityType: "automation_rule",
    entityId: rule.id,
    data: { trigger, matched, applied },
  });
  return { matched, applied };
}

/** Run all active run-on-import rules against newly imported transactions. */
export async function runRulesOnTransactions(
  userId: string,
  transactionIds: string[],
  trigger: "import" | "manual",
): Promise<number> {
  const rules = await db.query.automationRules.findMany({
    where: and(
      eq(automationRules.userId, userId),
      eq(automationRules.isActive, true),
      eq(automationRules.runOnImport, true),
    ),
    orderBy: [automationRules.priority],
  });
  let totalApplied = 0;
  for (const rule of rules) {
    const { applied } = await executeStoredRule(
      userId,
      rule.id,
      trigger,
      transactionIds,
    );
    totalApplied += applied;
  }
  return totalApplied;
}
