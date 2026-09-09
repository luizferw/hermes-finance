import "server-only";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
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

const ACTIONABLE_STATUSES = ["pending", "imported", "reviewed", "posted"] as const;

/** Rows fetched per keyset page while scanning. Bounds memory, not the scan. */
const SCAN_BATCH = 1000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A condition that no row can satisfy. */
const MATCHES_NOTHING = sql`false`;

/** Wrap a needle in LIKE wildcards, keeping `%`, `_` and `\` literal. */
function containsPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * SQL equivalent of one `matchesCondition` branch, or `null` when the condition
 * has no SQL form and can only be judged in memory.
 */
function conditionFilter(condition: RuleCondition): SQL | null {
  const value = condition.value;
  switch (condition.field) {
    case "description_contains":
      return or(
        ilike(transactions.description, containsPattern(value)),
        ilike(transactions.merchant, containsPattern(value)),
      )!;
    case "raw_text_contains":
      // `narration` is encrypted at rest, so half of this condition is
      // unsearchable in SQL — the whole condition stays in memory.
      return null;
    case "amount_equals": {
      const amount = Math.abs(Number(value));
      return Number.isNaN(amount)
        ? MATCHES_NOTHING
        : sql`abs(${transactions.amountMinor}) = ${amount}`;
    }
    case "amount_greater_than": {
      const amount = Math.abs(Number(value));
      return Number.isNaN(amount)
        ? MATCHES_NOTHING
        : sql`abs(${transactions.amountMinor}) > ${amount}`;
    }
    case "amount_less_than": {
      const amount = Math.abs(Number(value));
      return Number.isNaN(amount)
        ? MATCHES_NOTHING
        : sql`abs(${transactions.amountMinor}) < ${amount}`;
    }
    case "account_is":
      // A non-uuid value matches no row, and would be a cast error in SQL.
      return UUID_PATTERN.test(value)
        ? eq(transactions.accountId, value)
        : MATCHES_NOTHING;
    case "transaction_type_is":
      // Compared as text: an unknown value is false, not an enum cast error.
      return sql`${transactions.type}::text = ${value}`;
  }
}

/**
 * Push a rule's conditions down into the query so the scan only reads rows that
 * *could* match. Never narrower than the real predicate: a condition with no SQL
 * form is dropped from an AND and forces a full scan in an OR. `matchesRule`
 * still has the final say in memory.
 */
function ruleFilter(definition: RuleDefinition): SQL | undefined {
  if (definition.conditions.length === 0) return MATCHES_NOTHING;
  const parts = definition.conditions.map(conditionFilter);
  if (definition.matchAll) {
    const expressible = parts.filter((part): part is SQL => part !== null);
    return expressible.length > 0 ? and(...expressible) : undefined;
  }
  return parts.includes(null) ? undefined : or(...(parts as SQL[]));
}

function actionableTransactions(userId: string, extra?: SQL) {
  return and(
    eq(transactions.userId, userId),
    isNull(transactions.deletedAt),
    inArray(transactions.status, [...ACTIONABLE_STATUSES]),
    extra,
  );
}

/**
 * Every transaction a rule could act on, newest first, streamed in keyset pages
 * so the scan is bounded by memory rather than by an arbitrary row cap. Keyset
 * (not offset) because callers write to the rows as they consume them.
 */
export async function* candidateTransactions(
  userId: string,
  filter: SQL | undefined,
  batchSize = SCAN_BATCH,
): AsyncGenerator<typeof transactions.$inferSelect> {
  let cursor: { date: string; id: string } | null = null;
  for (;;) {
    const page: (typeof transactions.$inferSelect)[] =
      await db.query.transactions.findMany({
        where: actionableTransactions(
          userId,
          cursor
            ? and(
                filter,
                sql`(${transactions.date}, ${transactions.id}) < (${cursor.date}::date, ${cursor.id}::uuid)`,
              )
            : filter,
        ),
        orderBy: [desc(transactions.date), desc(transactions.id)],
        limit: batchSize,
      });
    if (page.length === 0) return;
    yield* page;
    if (page.length < batchSize) return;
    const last = page[page.length - 1]!;
    cursor = { date: last.date, id: last.id };
  }
}

/** How many transactions are in scope for rules at all. */
async function actionableCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(transactions)
    .where(actionableTransactions(userId));
  return row?.value ?? 0;
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

/** Dry-run a rule definition against the whole ledger. */
export async function previewRuleDefinition(
  userId: string,
  definition: RuleDefinition,
): Promise<RulePreviewResult> {
  const diff = evaluateActions(definition.actions);
  const sample: RulePreviewResult["sample"] = [];
  let matchedCount = 0;

  for await (const tx of candidateTransactions(userId, ruleFilter(definition))) {
    if (!matchesRule(toRuleTransaction(tx), definition)) continue;
    matchedCount += 1;
    if (sample.length < 8) {
      sample.push({
        id: tx.id,
        description: tx.description,
        date: tx.date,
        amountMinor: tx.amountMinor,
        currencyCode: tx.currencyCode,
        diff,
      });
    }
  }

  return { matchedCount, scannedCount: await actionableCount(userId), sample };
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
 * Execute a stored rule against transactions (the whole ledger, or a given set).
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
    : candidateTransactions(userId, ruleFilter(definition));

  const diff = evaluateActions(definition.actions);
  const startedAt = new Date();
  let matched = 0;
  let applied = 0;
  for await (const tx of candidates) {
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
