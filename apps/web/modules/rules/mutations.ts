"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  automationRuleActions,
  automationRuleConditions,
  automationRules,
  db,
} from "@kosh/db";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import {
  assertBillsOwned,
  assertBudgetsOwned,
  assertCategoriesOwned,
  assertTagsOwned,
} from "@/modules/shared/ownership";
import {
  createRuleSchema,
  type CreateRuleInput,
  type UpdateRuleInput,
} from "./validators";
import {
  executeStoredRule,
  previewRuleDefinition,
  type RulePreviewResult,
} from "./engine";
import { updateRuleCore } from "./core";

/** Rule actions carry ids of other user-owned records; validate ownership. */
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

export async function createRule(input: CreateRuleInput) {
  const user = await requireUser();
  const data = createRuleSchema.parse(input);
  await assertRuleActionsOwned(user.id, data.actions);

  const rule = await db.transaction(async (trx) => {
    const [created] = await trx
      .insert(automationRules)
      .values({
        userId: user.id,
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
    userId: user.id,
    action: "rule.created",
    entityType: "automation_rule",
    entityId: rule.id,
    data: { name: data.name },
  });
  revalidatePath("/automations");
  return rule;
}

export async function updateRule(ruleId: string, input: UpdateRuleInput) {
  const user = await requireUser();
  const rule = await updateRuleCore(user.id, ruleId, input);
  revalidatePath("/automations");
  return rule;
}

/** Dry-run an unsaved rule definition (used by the rule builder). */
export async function previewRule(
  input: CreateRuleInput,
): Promise<RulePreviewResult> {
  const user = await requireUser();
  const data = createRuleSchema.parse(input);
  return previewRuleDefinition(user.id, {
    matchAll: data.matchAll,
    conditions: data.conditions,
    actions: data.actions.map((a) => ({ type: a.type, value: a.value ?? null })),
  });
}

/** Dry-run a stored rule. */
export async function previewStoredRule(ruleId: string): Promise<RulePreviewResult> {
  const user = await requireUser();
  const rule = await db.query.automationRules.findFirst({
    where: and(eq(automationRules.id, ruleId), eq(automationRules.userId, user.id)),
    with: { conditions: true, actions: true },
  });
  if (!rule) throw new ApiError(404, "not_found", "Rule not found.");
  return previewRuleDefinition(user.id, {
    matchAll: rule.matchAll,
    conditions: rule.conditions.map((c) => ({ field: c.field, value: c.value })),
    actions: rule.actions.map((a) => ({ type: a.type, value: a.value })),
  });
}

export async function runRule(ruleId: string) {
  const user = await requireUser();
  const result = await executeStoredRule(user.id, ruleId, "manual");
  revalidatePath("/automations");
  revalidatePath("/transactions");
  revalidatePath("/inbox");
  return result;
}

export async function setRuleActive(ruleId: string, isActive: boolean) {
  const user = await requireUser();
  const existing = await db.query.automationRules.findFirst({
    where: and(eq(automationRules.id, ruleId), eq(automationRules.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Rule not found.");
  await db
    .update(automationRules)
    .set({ isActive })
    .where(eq(automationRules.id, ruleId));
  revalidatePath("/automations");
}

export async function deleteRule(ruleId: string) {
  const user = await requireUser();
  const existing = await db.query.automationRules.findFirst({
    where: and(eq(automationRules.id, ruleId), eq(automationRules.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Rule not found.");
  await db.delete(automationRules).where(eq(automationRules.id, ruleId));
  await logAudit({
    userId: user.id,
    action: "rule.deleted",
    entityType: "automation_rule",
    entityId: ruleId,
    data: { name: existing.name },
  });
  revalidatePath("/automations");
}
