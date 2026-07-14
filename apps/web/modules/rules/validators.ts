import { z } from "zod";

export const ruleConditionSchema = z.object({
  field: z.enum([
    "description_contains",
    "amount_equals",
    "amount_greater_than",
    "amount_less_than",
    "account_is",
    "raw_text_contains",
    "transaction_type_is",
  ]),
  value: z.string().min(1, "Condition needs a value").max(300),
});

export const ruleActionSchema = z.object({
  type: z.enum([
    "set_category",
    "add_tag",
    "rename_merchant",
    "mark_reviewed",
    "assign_budget",
    "link_bill",
  ]),
  value: z.string().max(300).nullish(),
});

export const createRuleSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  description: z.string().max(500).optional(),
  matchAll: z.boolean().default(true),
  runOnImport: z.boolean().default(true),
  conditions: z.array(ruleConditionSchema).min(1, "Add at least one condition").max(10),
  actions: z.array(ruleActionSchema).min(1, "Add at least one action").max(10),
});

export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type RuleConditionInput = z.infer<typeof ruleConditionSchema>;
export type RuleActionInput = z.infer<typeof ruleActionSchema>;
