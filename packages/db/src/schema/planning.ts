import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { recurrenceIntervalEnum, transactionTypeEnum } from "./enums";
import { encryptedText, timestamps } from "./helpers";
import { users } from "./auth";
import { accounts } from "./accounts";
import { categories } from "./taxonomy";

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    isArchived: boolean("is_archived").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("budgets_user_id_idx").on(t.userId),
    uniqueIndex("budgets_user_name_unique").on(t.userId, t.name),
  ],
);

/** Categories whose spending counts against a budget. */
export const budgetCategories = pgTable(
  "budget_categories",
  {
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.budgetId, t.categoryId] })],
);

/**
 * One row per budget per month. `rolloverEnabled` is stored now so rollover
 * math can be added later without a schema change; v0 ignores it.
 */
export const budgetPeriods = pgTable(
  "budget_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    plannedAmountMinor: bigint("planned_amount_minor", {
      mode: "number",
    }).notNull(),
    currencyCode: text("currency_code").notNull(),
    rolloverEnabled: boolean("rollover_enabled").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check("budget_periods_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("budget_periods_planned_nonnegative_check", sql`${t.plannedAmountMinor} >= 0`),
    check("budget_periods_date_order_check", sql`${t.periodEnd} >= ${t.periodStart}`),
    uniqueIndex("budget_periods_budget_start_unique").on(
      t.budgetId,
      t.periodStart,
    ),
    index("budget_periods_period_start_idx").on(t.periodStart),
  ],
);

export const bills = pgTable(
  "bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    expectedAmountMinor: bigint("expected_amount_minor", {
      mode: "number",
    }).notNull(),
    currencyCode: text("currency_code").notNull(),
    recurrence: recurrenceIntervalEnum("recurrence")
      .notNull()
      .default("monthly"),
    /** Day of month payment is due (1-31), used to roll nextDueDate forward. */
    dueDay: smallint("due_day"),
    nextDueDate: date("next_due_date", { mode: "string" }).notNull(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    lastPaidDate: date("last_paid_date", { mode: "string" }),
    /**
     * Transaction that satisfied the last due date. Soft reference (no FK)
     * because transactions are declared after bills.
     */
    lastPaidTransactionId: uuid("last_paid_transaction_id"),
    notes: encryptedText("notes"),
    ...timestamps,
  },
  (t) => [
    check("bills_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("bills_expected_amount_positive_check", sql`${t.expectedAmountMinor} > 0`),
    check("bills_due_day_check", sql`${t.dueDay} IS NULL OR (${t.dueDay} >= 1 AND ${t.dueDay} <= 31)`),
    index("bills_user_id_idx").on(t.userId),
    index("bills_next_due_date_idx").on(t.nextDueDate),
  ],
);

export const recurringTransactions = pgTable(
  "recurring_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: transactionTypeEnum("type").notNull(),
    accountId: uuid("account_id").notNull(),
    /** Destination account when type = transfer. */
    transferAccountId: uuid("transfer_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    description: text("description").notNull(),
    interval: recurrenceIntervalEnum("interval").notNull().default("monthly"),
    nextRunDate: date("next_run_date", { mode: "string" }).notNull(),
    lastRunDate: date("last_run_date", { mode: "string" }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    check("recurring_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("recurring_amount_nonzero_check", sql`${t.amountMinor} <> 0`),
    check(
      "recurring_transfer_account_check",
      sql`(${t.type}::text = 'transfer' AND ${t.transferAccountId} IS NOT NULL) OR (${t.type}::text <> 'transfer')`,
    ),
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [accounts.id, accounts.userId],
      name: "recurring_account_owner_fk",
    }).onDelete("cascade"),
    index("recurring_transactions_user_id_idx").on(t.userId),
    index("recurring_transactions_next_run_idx").on(t.nextRunDate),
  ],
);

export const savingsGoals = pgTable(
  "savings_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetAmountMinor: bigint("target_amount_minor", {
      mode: "number",
    }).notNull(),
    currentAmountMinor: bigint("current_amount_minor", { mode: "number" })
      .notNull()
      .default(0),
    currencyCode: text("currency_code").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    targetDate: date("target_date", { mode: "string" }),
    color: text("color"),
    achievedAt: date("achieved_at", { mode: "string" }),
    ...timestamps,
  },
  (t) => [
    check("savings_goals_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check("savings_goals_target_nonnegative_check", sql`${t.targetAmountMinor} >= 0`),
    check("savings_goals_current_nonnegative_check", sql`${t.currentAmountMinor} >= 0`),
    index("savings_goals_user_id_idx").on(t.userId),
  ],
);
