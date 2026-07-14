import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  automationRuleActions,
  automationRuleConditions,
  automationRules,
  automationRuns,
  db,
} from "@kosh/db";
import { logAudit } from "@/modules/shared/audit";
import {
  assertBillsOwned,
  assertBudgetsOwned,
  assertCategoriesOwned,
  assertTagsOwned,
} from "@/modules/shared/ownership";
import { createRuleSchema, type CreateRuleInput } from "./validators";
import { executeStoredRule } from "./engine";

/**
 * Session-free rule operations keyed on an explicit userId, so the Gemini agent
 * and external MCP clients share the same deterministic implementation as the
 * server actions. Identity is never taken from the model — callers pass the
 * authenticated userId.
 */

async function assertRuleActionsOwned(
  userId: string,
  actions: CreateRuleInput["actions"],
): Promise<void> {
  const byType = (type: string) =>
    actions.filter((a) => a.type === type).map((a) => a.value ?? null);
  await assertCategoriesOwned(userId, byType("set_category"));
  await assertTagsOwned(userId, byType("add_tag"));
  await assertBillsOwned(userId, byType("link_bill"));
  await assertBudgetsOwned(userId, byType("assign_budget"));
}

export async function createRuleCore(userId: string, input: CreateRuleInput) {
  const data = createRuleSchema.parse(input);
  await assertRuleActionsOwned(userId, data.actions);

  const rule = await db.transaction(async (trx) => {
    const [created] = await trx
      .insert(automationRules)
      .values({
        userId,
        name: data.name,
        description: data.description,
        matchAll: data.matchAll,
        runOnImport: data.runOnImport,
      })
      .returning();
    await trx.insert(automationRuleConditions).values(
      data.conditions.map((c) => ({ ruleId: created!.id, field: c.field, value: c.value })),
    );
    await trx.insert(automationRuleActions).values(
      data.actions.map((a) => ({ ruleId: created!.id, type: a.type, value: a.value ?? null })),
    );
    return created!;
  });

  await logAudit({
    userId,
    action: "rule.created",
    entityType: "automation_rule",
    entityId: rule.id,
    data: { name: data.name, source: "agent" },
  });
  return rule;
}

export async function listRulesCore(userId: string) {
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

export async function setRuleActiveCore(userId: string, ruleId: string, isActive: boolean) {
  const existing = await db.query.automationRules.findFirst({
    where: and(eq(automationRules.id, ruleId), eq(automationRules.userId, userId)),
  });
  if (!existing) throw new Error("Rule not found.");
  await db.update(automationRules).set({ isActive }).where(eq(automationRules.id, ruleId));
  await logAudit({
    userId,
    action: isActive ? "rule.enabled" : "rule.disabled",
    entityType: "automation_rule",
    entityId: ruleId,
    data: { source: "agent" },
  });
  return { name: existing.name, isActive };
}

export async function runRuleCore(userId: string, ruleId: string) {
  return executeStoredRule(userId, ruleId, "manual");
}
