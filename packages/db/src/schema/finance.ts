import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { accounts } from "./accounts";
import { categories } from "./taxonomy";
import { transactions } from "./transactions";

export const confidenceEnum = pgEnum("forecast_confidence", ["actual", "confirmed", "high", "medium", "low"]);
export const reserveKindEnum = pgEnum("financial_reserve_kind", ["hard", "soft"]);
export const cardCycleStatusEnum = pgEnum("credit_card_cycle_status", ["open", "closed", "paid", "overdue", "needs_review"]);
export const installmentStatusEnum = pgEnum("installment_status", ["projected", "billed", "paid", "cancelled"]);
export const purchasePlanStatusEnum = pgEnum("purchase_plan_status", ["active", "completed", "archived"]);
export const purchaseItemPriorityEnum = pgEnum("purchase_item_priority", ["must_have", "high", "medium", "low", "optional"]);
export const purchaseItemStatusEnum = pgEnum("purchase_item_status", ["idea", "planned", "ready", "purchased", "cancelled"]);
export const paymentMethodEnum = pgEnum("payment_method", ["pix", "boleto", "cash", "credit_card", "debit_card"]);

/** A dated observation. Unlike accounts.currentBalanceMinor this is auditable and freshness-aware. */
export const balanceSnapshots = pgTable("balance_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  observedAt: date("observed_at", { mode: "string" }).notNull(),
  source: text("source").notNull().default("manual"),
  importFileId: uuid("import_file_id"),
  createdAt: date("created_at", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
}, (t) => [
  uniqueIndex("balance_snapshots_account_observed_unique").on(t.accountId, t.observedAt),
  index("balance_snapshots_user_observed_idx").on(t.userId, t.observedAt),
]);

export const financialReserves = pgTable("financial_reserves", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: reserveKindEnum("kind").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currencyCode: text("currency_code").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: date("created_at", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
}, (t) => [
  check("financial_reserves_amount_nonnegative", sql`${t.amountMinor} >= 0`),
  check("financial_reserves_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  index("financial_reserves_user_idx").on(t.userId),
]);

export const creditCards = pgTable("credit_cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  issuer: text("issuer"),
  currencyCode: text("currency_code").notNull(),
  creditLimitMinor: bigint("credit_limit_minor", { mode: "number" }).notNull(),
  defaultClosingDay: integer("default_closing_day").notNull(),
  defaultDueDay: integer("default_due_day").notNull(),
  paymentAccountId: uuid("payment_account_id").references(() => accounts.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  createdAt: date("created_at", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
}, (t) => [
  check("credit_cards_limit_nonnegative", sql`${t.creditLimitMinor} >= 0`),
  check("credit_cards_closing_day_valid", sql`${t.defaultClosingDay} BETWEEN 1 AND 31`),
  check("credit_cards_due_day_valid", sql`${t.defaultDueDay} BETWEEN 1 AND 31`),
  uniqueIndex("credit_cards_user_name_unique").on(t.userId, t.name),
  uniqueIndex("credit_cards_account_unique").on(t.accountId),
]);

export const creditCardBillingCycles = pgTable("credit_card_billing_cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditCardId: uuid("credit_card_id").notNull().references(() => creditCards.id, { onDelete: "cascade" }),
  statementMonth: date("statement_month", { mode: "string" }).notNull(),
  openedAt: date("opened_at", { mode: "string" }).notNull(),
  closedAt: date("closed_at", { mode: "string" }),
  dueAt: date("due_at", { mode: "string" }).notNull(),
  confirmedTotalMinor: bigint("confirmed_total_minor", { mode: "number" }),
  source: text("source").notNull().default("manual"),
  status: cardCycleStatusEnum("status").notNull().default("open"),
}, (t) => [
  check("credit_card_cycles_date_order", sql`${t.dueAt} >= ${t.openedAt}`),
  uniqueIndex("credit_card_cycles_card_month_unique").on(t.creditCardId, t.statementMonth),
  index("credit_card_cycles_due_idx").on(t.dueAt),
]);

export const creditCardPurchases = pgTable("credit_card_purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditCardId: uuid("credit_card_id").notNull().references(() => creditCards.id, { onDelete: "cascade" }),
  transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
  purchaseDate: date("purchase_date", { mode: "string" }).notNull(),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  merchant: text("merchant"),
  totalAmountMinor: bigint("total_amount_minor", { mode: "number" }).notNull(),
}, (t) => [
  check("credit_card_purchases_total_positive", sql`${t.totalAmountMinor} > 0`),
  uniqueIndex("credit_card_purchases_transaction_unique").on(t.transactionId),
  index("credit_card_purchases_card_date_idx").on(t.creditCardId, t.purchaseDate),
]);

export const installmentPlans = pgTable("installment_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  creditCardPurchaseId: uuid("credit_card_purchase_id").notNull().references(() => creditCardPurchases.id, { onDelete: "cascade" }),
  totalInstallments: integer("total_installments").notNull(),
  firstInstallmentNumber: integer("first_installment_number").notNull().default(1),
  createdAt: date("created_at", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
}, (t) => [
  check("installment_plans_total_positive", sql`${t.totalInstallments} > 0`),
  check("installment_plans_first_valid", sql`${t.firstInstallmentNumber} BETWEEN 1 AND ${t.totalInstallments}`),
]);

export const installments = pgTable("installments", {
  id: uuid("id").primaryKey().defaultRandom(),
  installmentPlanId: uuid("installment_plan_id").notNull().references(() => installmentPlans.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  billingCycleId: uuid("billing_cycle_id").references(() => creditCardBillingCycles.id, { onDelete: "set null" }),
  expectedAt: date("expected_at", { mode: "string" }).notNull(),
  status: installmentStatusEnum("status").notNull().default("projected"),
  transactionId: uuid("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
}, (t) => [
  check("installments_number_positive", sql`${t.number} > 0`),
  check("installments_amount_positive", sql`${t.amountMinor} > 0`),
  uniqueIndex("installments_plan_number_unique").on(t.installmentPlanId, t.number),
  index("installments_expected_idx").on(t.expectedAt),
]);

/** Normalized input to the pure forecast engine. Actual or higher-confidence rows supersede the same logical key. */
export const projectedEvents = pgTable("projected_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  logicalKey: text("logical_key").notNull(),
  eventType: text("event_type").notNull(),
  expectedAt: date("expected_at", { mode: "string" }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  confidence: confidenceEnum("confidence").notNull(),
  resolvedByTransactionId: uuid("resolved_by_transaction_id").references(() => transactions.id, { onDelete: "set null" }),
  createdAt: date("created_at", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
}, (t) => [index("projected_events_user_date_idx").on(t.userId, t.expectedAt), index("projected_events_key_idx").on(t.userId, t.logicalKey)]);

export const purchasePlans = pgTable("purchase_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  targetDate: date("target_date", { mode: "string" }),
  budgetMinor: bigint("budget_minor", { mode: "number" }),
  currencyCode: text("currency_code").notNull(),
  status: purchasePlanStatusEnum("status").notNull().default("active"),
  createdAt: date("created_at", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
}, (t) => [index("purchase_plans_user_idx").on(t.userId)]);

export const purchaseItems = pgTable("purchase_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchasePlanId: uuid("purchase_plan_id").notNull().references(() => purchasePlans.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  priority: purchaseItemPriorityEnum("priority").notNull().default("medium"),
  estimatedPriceMinor: bigint("estimated_price_minor", { mode: "number" }).notNull(),
  actualPriceMinor: bigint("actual_price_minor", { mode: "number" }),
  earliestPurchaseDate: date("earliest_purchase_date", { mode: "string" }),
  deadline: date("deadline", { mode: "string" }),
  status: purchaseItemStatusEnum("status").notNull().default("idea"),
  notes: text("notes"),
  /**
   * Cap on how many installments this item may be split into — a seller that
   * only takes 3x, or none at all (1). Null means no restriction. It is a fact
   * about the world, so the recommender treats it as a hard constraint rather
   * than a preference.
   */
  maxInstallments: smallint("max_installments"),
  /**
   * The one option this item is actually being paid by, out of the
   * alternatives under it. Comparing options answers "which way is best";
   * this answers "which way did I pick", which is what lets the plan's
   * items be added up into a single simulation. Soft reference (no FK)
   * because payment_options is declared after purchase_items.
   */
  selectedPaymentOptionId: uuid("selected_payment_option_id"),
}, (t) => [
  check("purchase_items_estimated_nonnegative", sql`${t.estimatedPriceMinor} >= 0`),
  check("purchase_items_max_installments_positive", sql`${t.maxInstallments} IS NULL OR ${t.maxInstallments} >= 1`),
  index("purchase_items_plan_idx").on(t.purchasePlanId),
]);

export const paymentOptions = pgTable("payment_options", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchaseItemId: uuid("purchase_item_id").notNull().references(() => purchaseItems.id, { onDelete: "cascade" }),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  cardId: uuid("card_id").references(() => creditCards.id, { onDelete: "set null" }),
  cashPriceMinor: bigint("cash_price_minor", { mode: "number" }),
  installments: integer("installments"),
  installmentAmountMinor: bigint("installment_amount_minor", { mode: "number" }),
  totalCostMinor: bigint("total_cost_minor", { mode: "number" }).notNull(),
  firstPaymentDate: date("first_payment_date", { mode: "string" }),
}, (t) => [check("payment_options_total_nonnegative", sql`${t.totalCostMinor} >= 0`), index("payment_options_item_idx").on(t.purchaseItemId)]);

export const purchaseSimulations = pgTable("purchase_simulations", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchaseItemId: uuid("purchase_item_id").notNull().references(() => purchaseItems.id, { onDelete: "cascade" }),
  paymentOptionId: uuid("payment_option_id").notNull().references(() => paymentOptions.id, { onDelete: "cascade" }),
  forecastVersion: text("forecast_version").notNull(),
  currentBalanceMinor: bigint("current_balance_minor", { mode: "number" }).notNull(),
  minimumBalanceMinor: bigint("minimum_balance_minor", { mode: "number" }).notNull(),
  safeToSpendBeforeMinor: bigint("safe_to_spend_before_minor", { mode: "number" }).notNull(),
  safeToSpendAfterMinor: bigint("safe_to_spend_after_minor", { mode: "number" }).notNull(),
  reserveViolations: jsonb("reserve_violations").notNull().default([]),
  totalCostMinor: bigint("total_cost_minor", { mode: "number" }).notNull(),
  lastInstallmentDate: date("last_installment_date", { mode: "string" }),
  recommendationScore: integer("recommendation_score"),
  createdAt: date("created_at", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
});
