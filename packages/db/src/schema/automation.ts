import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ruleActionTypeEnum,
  ruleConditionFieldEnum,
  ruleRunTriggerEnum,
} from "./enums";
import { timestamps } from "./helpers";
import { users } from "./auth";

export const automationRules = pgTable(
  "automation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    /** Lower runs first. */
    priority: integer("priority").notNull().default(0),
    /** true = all conditions must match (AND); false = any (OR). */
    matchAll: boolean("match_all").notNull().default(true),
    /** Apply automatically to newly imported transactions. */
    runOnImport: boolean("run_on_import").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("automation_rules_user_id_idx").on(t.userId)],
);

export const automationRuleConditions = pgTable(
  "automation_rule_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    field: ruleConditionFieldEnum("field").notNull(),
    /**
     * Comparison value. Amounts are stored as minor-unit integers in string
     * form; account/type comparisons store the id/enum value.
     */
    value: text("value").notNull(),
    ...timestamps,
  },
  (t) => [index("automation_rule_conditions_rule_idx").on(t.ruleId)],
);

export const automationRuleActions = pgTable(
  "automation_rule_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    type: ruleActionTypeEnum("type").notNull(),
    /** Target id or text value; null for actions like mark_reviewed. */
    value: text("value"),
    ...timestamps,
  },
  (t) => [index("automation_rule_actions_rule_idx").on(t.ruleId)],
);

/** Every execution (manual, on-import, or test) is recorded for audit. */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").references(() => automationRules.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trigger: ruleRunTriggerEnum("trigger").notNull(),
    matchedCount: integer("matched_count").notNull().default(0),
    appliedCount: integer("applied_count").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("automation_runs_rule_idx").on(t.ruleId),
    index("automation_runs_user_idx").on(t.userId),
  ],
);
