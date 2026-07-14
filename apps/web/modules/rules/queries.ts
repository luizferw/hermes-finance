import "server-only";
import { asc, desc, eq } from "drizzle-orm";
import { automationRules, automationRuns, db, transactions } from "@kosh/db";
import { suggestRules, type RuleSuggestion } from "@kosh/domain";
import { and, inArray, isNull } from "drizzle-orm";

export async function listRules(userId: string) {
  return db.query.automationRules.findMany({
    where: eq(automationRules.userId, userId),
    with: {
      conditions: true,
      actions: true,
      runs: { orderBy: [desc(automationRuns.startedAt)], limit: 1 },
    },
    orderBy: [asc(automationRules.priority), asc(automationRules.name)],
  });
}

export async function getRule(userId: string, id: string) {
  return db.query.automationRules.findFirst({
    where: and(eq(automationRules.id, id), eq(automationRules.userId, userId)),
    with: { conditions: true, actions: true },
  });
}

export async function listRuleRuns(userId: string, limit = 20) {
  return db.query.automationRuns.findMany({
    where: eq(automationRuns.userId, userId),
    with: { rule: { columns: { id: true, name: true } } },
    orderBy: [desc(automationRuns.startedAt)],
    limit,
  });
}

/** Suggested rules from repeated merchants among uncategorized inbox items. */
export async function getRuleSuggestions(userId: string): Promise<RuleSuggestion[]> {
  const recent = await db.query.transactions.findMany({
    where: and(
      eq(transactions.userId, userId),
      isNull(transactions.deletedAt),
      inArray(transactions.status, ["imported", "pending", "posted", "reviewed"]),
    ),
    columns: { description: true, categoryId: true, status: true },
    orderBy: [desc(transactions.date)],
    limit: 500,
  });
  // Suggest only when uncategorized occurrences exist in the inbox.
  const uncategorizedTokens = new Set(
    recent
      .filter((t) => !t.categoryId && (t.status === "imported" || t.status === "pending"))
      .map((t) => t.description.toLowerCase()),
  );
  return suggestRules(recent, 3)
    .filter((s) =>
      [...uncategorizedTokens].some((d) => d.includes(s.token)),
    )
    .slice(0, 5);
}
