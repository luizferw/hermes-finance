import "server-only";
import { z, type ZodType } from "zod";
import {
  addMonthsClamped,
  formatMoney,
  monthRange,
  todayIso,
} from "@kosh/domain";
import { getNetWorthSummary, listAccounts } from "@/modules/accounts/queries";
import {
  getMonthSummary,
  getMonthSummaryFor,
  getSpendingByCategory,
  getRecentCashflow,
} from "@/modules/reports/queries";
import {
  listTransactions,
  getTransaction,
  getInboxItems,
} from "@/modules/transactions/queries";
import { getUpcomingBills, listBills } from "@/modules/bills/queries";
import { listRecurring } from "@/modules/recurring/queries";
import { listGoals } from "@/modules/goals/queries";
import { listBudgetsWithProgress } from "@/modules/budgets/queries";
import { getPatternsView } from "@/modules/patterns/queries";
import { buildUserForecast, getSafeToSpend } from "@/modules/finance/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import {
  createTransactionCore,
  updateTransactionCore,
  approveTransactionsCore,
  bulkCategorizeCore,
} from "@/modules/transactions/mutations";
import { createGoalCore } from "@/modules/goals/mutations";
import {
  createRuleCore,
  listRulesCore,
  setRuleActiveCore,
  runRuleCore,
} from "@/modules/rules/core";
import { previewRuleDefinition } from "@/modules/rules/engine";
import type { CreateRuleInput } from "@/modules/rules/validators";
import type {
  ReadTool,
  ReadToolResult,
  WriteTool,
  Tool,
  ToolContext,
  PreparedWrite,
  ExecStatus,
  ResponseBlock,
  Scope,
} from "./types";

/* ── definition helpers (infer arg type from the zod schema) ────────────── */

function read<S extends ZodType>(t: {
  name: string;
  title: string;
  description: string;
  requiredScope: Scope;
  input: S;
  execute: (ctx: ToolContext, args: z.infer<S>) => Promise<ReadToolResult>;
}): ReadTool<z.infer<S>> {
  return { kind: "read", risk: "read", ...t };
}

function write<S extends ZodType>(t: {
  name: string;
  title: string;
  description: string;
  risk: "write" | "sensitive";
  requiredScope: Scope;
  input: S;
  prepare: (ctx: ToolContext, args: z.infer<S>) => Promise<PreparedWrite>;
  execute: WriteTool<z.infer<S>>["execute"];
}): WriteTool<z.infer<S>> {
  return { kind: "write", ...t };
}

/* ── shared resolution (names → owned ids; never trust model ids blindly) ─ */

async function resolveAccount(userId: string, hint?: string) {
  const accounts = (await listAccounts(userId)).filter((a) => !a.isArchived);
  if (!hint) return accounts[0] ?? null;
  const h = hint.toLowerCase();
  return (
    accounts.find((a) => a.name.toLowerCase() === h) ??
    accounts.find((a) => a.name.toLowerCase().includes(h)) ??
    accounts[0] ??
    null
  );
}

async function resolveCategory(userId: string, hint?: string | null) {
  if (!hint) return null;
  const cats = await listCategories(userId);
  const h = hint.toLowerCase();
  return (
    cats.find((c) => c.name.toLowerCase() === h) ??
    cats.find((c) => c.name.toLowerCase().includes(h)) ??
    null
  );
}

function monthIsoFor(period?: "this_month" | "last_month") {
  return period === "last_month" ? addMonthsClamped(todayIso(), -1) : todayIso();
}

function monthLabel(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(
    new Date(`${iso.slice(0, 7)}-01T00:00:00`),
  );
}

function currencyWarning(
  defaultCurrency: string,
  currencies: string[],
): ResponseBlock | undefined {
  const otherCurrencies = [...new Set(currencies)].filter(
    (currency) => currency !== defaultCurrency,
  );
  return otherCurrencies.length
    ? {
        type: "currencyWarning",
        defaultCurrency,
        otherCurrencies,
        text: `Totals use ${defaultCurrency}. Other currencies are shown separately and are not added to it.`,
      }
    : undefined;
}

function currencyWarningBlocks(defaultCurrency: string, currencies: string[]) {
  const warning = currencyWarning(defaultCurrency, currencies);
  return warning ? [warning] : undefined;
}

const periodSchema = z.enum(["this_month", "last_month"]).optional();

/* ── rule construction (narrow, typed; values resolved to owned ids) ──────── */

// A deliberately narrow surface for conversational rule-building. The model
// works in names; we resolve to owned ids before anything is stored or run.
const ruleConditionInput = z.object({
  field: z.enum([
    "description_contains",
    "raw_text_contains",
    "amount_greater_than",
    "amount_less_than",
    "amount_equals",
    "account_is",
    "transaction_type_is",
  ]),
  value: z.string().min(1).max(300).describe(
    "text to match; for account_is pass the account name; for transaction_type_is pass income|expense|transfer; for amount_* pass major units",
  ),
});
const ruleActionInput = z.object({
  type: z.enum(["set_category", "rename_merchant", "mark_reviewed"]),
  value: z.string().max(300).nullish().describe("category name for set_category; new merchant name for rename_merchant; omit for mark_reviewed"),
});
const ruleInput = z.object({
  name: z.string().min(1).max(120),
  matchAll: z.boolean().default(true).describe("true = all conditions must match (AND); false = any (OR)"),
  conditions: z.array(ruleConditionInput).min(1).max(10),
  actions: z.array(ruleActionInput).min(1).max(10),
});
type RuleInput = z.infer<typeof ruleInput>;

const CONDITION_LABEL: Record<string, string> = {
  description_contains: "description contains",
  raw_text_contains: "raw text contains",
  amount_greater_than: "amount greater than",
  amount_less_than: "amount less than",
  amount_equals: "amount equals",
  account_is: "account is",
  transaction_type_is: "type is",
};

/** Resolve model-friendly names to the concrete, owned ids the engine stores. */
async function resolveRule(ctx: ToolContext, input: RuleInput): Promise<{
  definition: CreateRuleInput;
  conditionLabels: Array<{ field: string; value: string; label: string }>;
  actionLabels: Array<{ type: string; value: string | null; label: string }>;
}> {
  const conditions: CreateRuleInput["conditions"] = [];
  const conditionLabels = [];
  for (const c of input.conditions) {
    let value = c.value;
    let display = c.value;
    if (c.field === "account_is") {
      const acct = await resolveAccount(ctx.userId, c.value);
      if (!acct) throw new Error(`No account matching "${c.value}".`);
      value = acct.id;
      display = acct.name;
    } else if (c.field.startsWith("amount_")) {
      const minor = Math.round(Number(c.value) * 100);
      if (!Number.isFinite(minor)) throw new Error(`"${c.value}" is not an amount.`);
      value = String(minor);
      display = formatMoney(minor, ctx.currency);
    }
    conditions.push({ field: c.field, value });
    conditionLabels.push({ field: c.field, value, label: `${CONDITION_LABEL[c.field]} ${display}` });
  }

  const actions: CreateRuleInput["actions"] = [];
  const actionLabels = [];
  for (const a of input.actions) {
    if (a.type === "set_category") {
      const cat = await resolveCategory(ctx.userId, a.value ?? null);
      if (!cat) throw new Error(`No category matching "${a.value}".`);
      actions.push({ type: "set_category", value: cat.id });
      actionLabels.push({ type: a.type, value: cat.id, label: `categorise as ${cat.name}` });
    } else if (a.type === "rename_merchant") {
      if (!a.value) throw new Error("rename_merchant needs a new merchant name.");
      actions.push({ type: "rename_merchant", value: a.value });
      actionLabels.push({ type: a.type, value: a.value, label: `rename merchant to ${a.value}` });
    } else {
      actions.push({ type: "mark_reviewed", value: null });
      actionLabels.push({ type: a.type, value: null, label: "mark reviewed" });
    }
  }

  return {
    definition: { name: input.name, matchAll: input.matchAll, runOnImport: true, conditions, actions },
    conditionLabels,
    actionLabels,
  };
}

/* ── READ TOOLS ─────────────────────────────────────────────────────────── */

const readTools: ReadTool[] = [
  read({
    name: "get_financial_snapshot",
    title: "Financial snapshot",
    description:
      "Net worth, assets, liabilities, and this month's income/expense/net. Use for 'how am I doing' overview questions.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [nw, month] = await Promise.all([
        getNetWorthSummary(ctx.userId),
        getMonthSummary(ctx.userId),
      ]);
      const forModel = {
        netWorthMinor: nw.netWorthMinor,
        assetsMinor: nw.assetsMinor,
        liabilitiesMinor: nw.liabilitiesMinor,
        monthIncomeMinor: month.incomeMinor,
        monthExpenseMinor: month.expenseMinor,
        monthNetMinor: month.netMinor,
        currency: ctx.currency,
      };
      return {
        forModel,
        block: {
          type: "figure",
          title: "Net worth",
          figure: { label: "Net worth", amountMinor: nw.netWorthMinor, currency: ctx.currency },
          caption: `This month: kept ${formatMoney(month.netMinor, ctx.currency)}`,
        },
      };
    },
  }),

  read({
    name: "get_safe_to_spend",
    title: "Safe to spend",
    description: "Deterministic safe-to-spend from the consolidated daily cash forecast and configured hard reserves.",
    requiredScope: "finance:read",
    input: z.object({
      horizonDays: z.number().int().min(1).max(365).default(30),
    }),
    async execute(ctx, args) {
      const result = await getSafeToSpend(ctx.userId, args.horizonDays);
      const committedMinor = result.forecast.events.filter((event) => event.amountMinor < 0).reduce((total, event) => total + -event.amountMinor, 0);
      return {
        forModel: {
          safeToSpendMinor: result.safeToSpendMinor,
          minimumBalanceMinor: result.minimumBalanceMinor,
          minimumBalanceDate: result.minimumBalanceDate,
          hardReserveViolated: result.hardReserveViolated,
          hardReserveMinor: result.forecast.minimumBalanceMinor - result.safeToSpendMinor,
          horizonEnd: result.forecast.horizonEnd,
          currency: ctx.currency,
        },
        block: {
          type: "safeToSpend",
          title: "Safe to spend",
          period: `${result.forecast.asOf} to ${result.forecast.horizonEnd}`,
          safeMinor: result.safeToSpendMinor,
          incomeMinor: result.forecast.events.filter((event) => event.amountMinor > 0).reduce((total, event) => total + event.amountMinor, 0),
          expenseMinor: committedMinor,
          committedMinor,
          currency: ctx.currency,
          note: `Minimum projected balance ${formatMoney(result.minimumBalanceMinor, ctx.currency)} on ${result.minimumBalanceDate}.`,
        },
      };
    },
  }),

  read({
    name: "search_transactions",
    title: "Search transactions",
    description:
      "Find transactions by text, date range, amount range, type, or status. Amounts are in major units (e.g. 5000 = ₹5,000).",
    requiredScope: "finance:read",
    input: z.object({
      text: z.string().max(200).optional().describe("merchant/description contains"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      minAmount: z.number().positive().optional(),
      maxAmount: z.number().positive().optional(),
      type: z.enum(["income", "expense", "transfer"]).optional(),
      status: z.enum(["pending", "imported", "reviewed", "posted"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    async execute(ctx, args) {
      const { items, total } = await listTransactions(ctx.userId, {
        q: args.text,
        from: args.from,
        to: args.to,
        minAmount: args.minAmount,
        maxAmount: args.maxAmount,
        type: args.type,
        status: args.status,
        page: 1,
        pageSize: args.limit,
      } as Parameters<typeof listTransactions>[1]);
      const rows = items.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amountMinor: t.amountMinor,
        currency: t.currencyCode,
        category: t.category?.name ?? null,
      }));
      return {
        forModel: { count: total, transactions: rows },
        block: {
          type: "transactions",
          title: "Transactions",
          rows,
          moreCount: Math.max(0, total - rows.length),
        },
      };
    },
  }),

  read({
    name: "get_transaction",
    title: "Get transaction",
    description: "Full detail for one transaction by id.",
    requiredScope: "finance:read",
    input: z.object({ id: z.string().uuid() }),
    async execute(ctx, args) {
      const tx = await getTransaction(ctx.userId, args.id);
      if (!tx) return { forModel: { error: "not_found" } };
      return {
        forModel: {
          id: tx.id,
          date: tx.date,
          description: tx.description,
          merchant: tx.merchant,
          amountMinor: tx.amountMinor,
          currency: tx.currencyCode,
          type: tx.type,
          status: tx.status,
          category: tx.category?.name ?? null,
          account: tx.account?.name ?? null,
        },
      };
    },
  }),

  read({
    name: "get_spending_breakdown",
    title: "Spending breakdown",
    description: "Spending grouped by category for this month or last month.",
    requiredScope: "finance:read",
    input: z.object({ period: periodSchema }),
    async execute(ctx, args) {
      const spending = await getSpendingByCategory(ctx.userId, monthIsoFor(args.period));
      const total = spending.reduce((s, c) => s + c.spentMinor, 0);
      const rows = spending.slice(0, 8).map((c) => ({
        name: c.name,
        color: c.color,
        spentMinor: c.spentMinor,
      }));
      return {
        forModel: { totalMinor: total, categories: rows, currency: ctx.currency },
        block: {
          type: "breakdown",
          title: args.period === "last_month" ? "Where it went · last month" : "Where it went",
          currency: ctx.currency,
          rows,
          totalMinor: total,
        },
      };
    },
  }),

  read({
    name: "compare_periods",
    title: "Compare months",
    description: "Income/expense/net for this month versus last month.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const thisIso = todayIso();
      const lastIso = addMonthsClamped(thisIso, -1);
      const [a, b] = await Promise.all([
        getMonthSummaryFor(ctx.userId, lastIso),
        getMonthSummaryFor(ctx.userId, thisIso),
      ]);
      const label = (iso: string) =>
        new Intl.DateTimeFormat("en-IN", { month: "long" }).format(
          new Date(`${iso.slice(0, 7)}-01T00:00:00`),
        );
      return {
        forModel: { last: { ...a, label: label(lastIso) }, current: { ...b, label: label(thisIso) }, currency: ctx.currency },
        block: {
          type: "comparison",
          title: "This month vs last",
          currency: ctx.currency,
          a: { label: label(lastIso), ...a },
          b: { label: label(thisIso), ...b },
        },
      };
    },
  }),

  read({
    name: "get_cash_flow",
    title: "Cash flow",
    description: "Daily inflow/outflow over the last N days (default 30).",
    requiredScope: "finance:read",
    input: z.object({ days: z.number().int().min(7).max(90).default(30) }),
    async execute(ctx, args) {
      const points = await getRecentCashflow(ctx.userId, args.days);
      const inflow = points.reduce((s, p) => s + p.inflowMinor, 0);
      const outflow = points.reduce((s, p) => s + p.outflowMinor, 0);
      return {
        forModel: { days: args.days, inflowMinor: inflow, outflowMinor: outflow, netMinor: inflow - outflow, currency: ctx.currency },
        block: {
          type: "cashflow",
          title: "Recorded cashflow",
          range: `Last ${args.days} days`,
          currency: ctx.currency,
          inflowMinor: inflow,
          outflowMinor: outflow,
          netMinor: inflow - outflow,
        },
      };
    },
  }),

  read({
    name: "get_accounts",
    title: "Accounts",
    description: "All active accounts with current balances.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const accounts = (await listAccounts(ctx.userId)).filter((a) => !a.isArchived).slice(0, 50);
      const rows = accounts.map((a) => ({
        id: a.id,
        name: a.name,
        balanceMinor: a.currentBalanceMinor,
        currency: a.currencyCode,
      }));
      return {
        forModel: { accounts: rows },
        block: { type: "accounts", title: "Accounts", rows },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_upcoming_commitments",
    title: "Upcoming commitments",
    description: "Bills due (and overdue) within the next N days (default 30).",
    requiredScope: "finance:read",
    input: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    async execute(ctx, args) {
      const bills = await getUpcomingBills(ctx.userId, args.days);
      const rows = bills.slice(0, 12).map((b) => ({
        id: b.bill.id,
        name: b.bill.name,
        amountMinor: b.bill.expectedAmountMinor,
        currency: b.bill.currencyCode,
        dueDate: b.bill.nextDueDate,
        daysUntilDue: b.daysUntilDue,
        overdue: b.state === "overdue",
      }));
      return {
        forModel: { commitments: rows, currency: ctx.currency },
        block: { type: "commitments", title: "Coming up", currency: ctx.currency, rows },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_recurring_transactions",
    title: "Recurring",
    description: "Active recurring commitments / subscriptions.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const all = (await listRecurring(ctx.userId)).filter((r) => r.isActive).slice(0, 20);
      const rows = all.map((r) => ({
        id: r.id,
        name: r.name,
        amountMinor: Math.abs(r.amountMinor),
        currency: r.currencyCode,
        interval: r.interval,
        nextDate: r.nextRunDate,
      }));
      return {
        forModel: { recurring: rows, currency: ctx.currency },
        block: { type: "recurring", title: "Recurring transactions", rows },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_goals",
    title: "Goals",
    description: "Savings goals with target, current, and projection inputs.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const goals = (await listGoals(ctx.userId)).slice(0, 20);
      const rows = goals.map((g) => ({
        id: g.id,
        name: g.name,
        currentMinor: g.currentAmountMinor,
        targetMinor: g.targetAmountMinor,
        ratio: g.targetAmountMinor > 0
          ? Math.min(1, g.currentAmountMinor / g.targetAmountMinor)
          : 0,
        currency: g.currencyCode,
        targetDate: g.targetDate,
      }));
      return {
        forModel: {
          goals: rows,
        },
        block: { type: "goals", title: "Savings goals", rows },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_budgets",
    title: "Budget progress",
    description:
      "Current-month budgets with planned, spent, and remaining amounts. Amounts stay in each budget's own currency.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const budgets = (await listBudgetsWithProgress(ctx.userId)).slice(0, 20);
      const rows = budgets.map((budget) => ({
        id: budget.id,
        name: budget.name,
        plannedMinor: budget.plannedMinor,
        spentMinor: budget.spentMinor,
        remainingMinor: budget.remainingMinor,
        ratio: budget.ratio,
        isOver: budget.isOver,
        currency: budget.hasPeriod ? budget.currencyCode : ctx.currency,
      }));
      return {
        forModel: {
          period: monthLabel(todayIso()),
          budgets: rows,
          missingPeriods: budgets.filter((budget) => !budget.hasPeriod).length,
        },
        block: {
          type: "budgets",
          title: "Budget status",
          period: monthLabel(todayIso()),
          rows,
        },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "find_unusual_spending",
    title: "Unusual spending",
    description:
      "Find the largest category-level changes this month versus last month. This is a simple change heuristic, not fraud detection.",
    requiredScope: "finance:read",
    input: z.object({ limit: z.number().int().min(1).max(8).default(5) }),
    async execute(ctx, args) {
      const patterns = await getPatternsView(ctx.userId);
      // category drift is a transparent heuristic; add transaction-level
      // seasonality only if users need real anomaly detection.
      const rows = patterns.drift
        .filter((row) => row.deltaMinor !== 0)
        .slice(0, args.limit)
        .map((row) => ({
          name: row.name,
          currentMinor: row.currentMinor,
          priorMinor: row.priorMinor,
          deltaMinor: row.deltaMinor,
          deltaPct: row.deltaPct,
          isNew: row.isNew,
        }));
      return {
        forModel: {
          currency: ctx.currency,
          method: "largest absolute category changes, current month versus prior month",
          changes: rows,
        },
        block: {
          type: "anomalies",
          title: "Largest spending changes",
          currency: ctx.currency,
          rows,
          note: "Category changes compared with last month. This highlights movement; it does not identify fraud.",
        },
      };
    },
  }),

  read({
    name: "list_missing_setup_items",
    title: "Missing setup",
    description:
      "List missing Kosh data that limits financial answers, such as accounts, transactions, budgets, bills, recurring items, or goals.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [accounts, txs, budgets, bills, recurring, goals] = await Promise.all([
        listAccounts(ctx.userId),
        listTransactions(ctx.userId, { page: 1, pageSize: 1 }),
        listBudgetsWithProgress(ctx.userId),
        listBills(ctx.userId),
        listRecurring(ctx.userId),
        listGoals(ctx.userId),
      ]);
      const items = [
        accounts.some((account) => !account.isArchived)
          ? null
          : { label: "Add an account", detail: "Balances and net worth need an account.", href: "/accounts" },
        txs.total > 0
          ? null
          : { label: "Import transactions", detail: "Spending and cashflow need ledger activity.", href: "/transactions/import" },
        budgets.length > 0
          ? null
          : { label: "Create a budget", detail: "Budget progress needs at least one budget.", href: "/plan/budgets" },
        bills.length > 0
          ? null
          : { label: "Track bills", detail: "Upcoming commitments need bill dates and amounts.", href: "/plan/bills" },
        recurring.length > 0
          ? null
          : { label: "Add recurring items", detail: "Recurring-spend answers need tracked schedules.", href: "/plan/recurring" },
        goals.length > 0
          ? null
          : { label: "Add a savings goal", detail: "Goal progress needs a target.", href: "/plan/goals" },
      ].filter((item): item is { label: string; detail: string; href: string } => item !== null);
      return {
        forModel: { complete: items.length === 0, missing: items.map((item) => item.label) },
        block: { type: "missingData", title: "Data readiness", items },
      };
    },
  }),

  read({
    name: "get_review_inbox",
    title: "Review inbox",
    description: "Transactions awaiting review (pending/imported), with duplicate hints.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const items = await getInboxItems(ctx.userId);
      const rows = items.slice(0, 15).map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amountMinor: t.amountMinor,
        currency: t.currencyCode,
        category: t.category?.name ?? null,
      }));
      return {
        forModel: { count: items.length, items: rows },
        block: { type: "transactions", title: "Awaiting review", rows, moreCount: Math.max(0, items.length - rows.length), href: "/inbox" },
      };
    },
  }),

  read({
    name: "get_available_categories",
    title: "Available categories",
    description: "Category names + ids, so writes can reference a valid category.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const cats = (await listCategories(ctx.userId)).slice(0, 100);
      return { forModel: { categories: cats.map((c) => ({ id: c.id, name: c.name })) } };
    },
  }),

  read({
    name: "get_available_accounts",
    title: "Available accounts",
    description: "Account names + ids + currency, so writes can reference a valid account.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const accounts = (await listAccounts(ctx.userId)).filter((a) => !a.isArchived).slice(0, 50);
      return {
        forModel: {
          accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currencyCode })),
        },
      };
    },
  }),

  read({
    name: "list_rules",
    title: "List rules",
    description: "List the user's automation rules with their status and last run.",
    requiredScope: "rules:read",
    input: z.object({}),
    async execute(ctx) {
      const rules = (await listRulesCore(ctx.userId)).slice(0, 50);
      const lines = rules.map((r) => ({
        id: r.id,
        name: r.name,
        isActive: r.isActive,
        priority: r.priority,
        conditionCount: r.conditions.length,
        actionCount: r.actions.length,
        lastRun: r.runs[0]
          ? { matched: r.runs[0].matchedCount, applied: r.runs[0].appliedCount, at: r.runs[0].startedAt.toISOString() }
          : null,
      }));
      return {
        forModel: { rules: lines.map((l) => ({ id: l.id, name: l.name, active: l.isActive })) },
        block: { type: "ruleList", title: "Your rules", rules: lines },
      };
    },
  }),

  read({
    name: "propose_rule",
    title: "Propose a rule (dry run)",
    description:
      "Build a deterministic rule from typed conditions and actions and DRY-RUN it against historical transactions. Does NOT save or activate anything — it returns the draft and what it would have matched so the user can review and narrow it. Always propose before creating.",
    requiredScope: "rules:read",
    input: ruleInput,
    async execute(ctx, args) {
      const { definition, conditionLabels, actionLabels } = await resolveRule(ctx, args);
      const preview = await previewRuleDefinition(ctx.userId, {
        matchAll: definition.matchAll,
        conditions: definition.conditions,
        actions: definition.actions.map((a) => ({ type: a.type, value: a.value ?? null })),
      });
      const broad = preview.matchedCount > 50 || args.conditions.some((c) => c.field.includes("contains") && c.value.length < 3);
      return {
        forModel: {
          name: definition.name,
          matchedCount: preview.matchedCount,
          scannedCount: preview.scannedCount,
          note: "Not saved. Call create_rule to activate after the user confirms.",
        },
        block: {
          type: "ruleDraft",
          draft: {
            name: definition.name,
            matchAll: definition.matchAll,
            conditions: conditionLabels,
            actions: actionLabels,
            matchedCount: preview.matchedCount,
            scannedCount: preview.scannedCount,
            sample: preview.sample.map((s) => ({
              description: s.description,
              date: s.date,
              amountMinor: s.amountMinor,
              currency: s.currencyCode,
            })),
            warning: broad ? "This looks broad — consider narrowing the conditions before activating." : undefined,
          },
        },
      };
    },
  }),
];

/* ── WRITE TOOLS ────────────────────────────────────────────────────────── */

const writeTools: WriteTool[] = [
  write({
    name: "create_transaction",
    title: "Add transaction",
    description:
      "Add an expense or income. Reference the account by name (e.g. 'HDFC') and an optional category by name. Amount in major units.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      description: z.string().min(1).max(300),
      amount: z.number().positive(),
      type: z.enum(["income", "expense"]).default("expense"),
      account: z.string().optional().describe("account name; defaults to the primary account"),
      category: z.string().optional().describe("category name"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      merchant: z.string().max(150).optional(),
    }),
    async prepare(ctx, args) {
      const account = await resolveAccount(ctx.userId, args.account);
      if (!account) throw new Error("No account found to add this to.");
      const category = await resolveCategory(ctx.userId, args.category);
      const date = args.date ?? todayIso();
      const payload = {
        accountId: account.id,
        type: args.type,
        amount: args.amount,
        description: args.description,
        merchant: args.merchant,
        categoryId: category?.id ?? null,
        date,
      };
      return {
        payload,
        title: "Add transaction?",
        summary: args.description,
        fields: [
          { label: "Amount", value: `${formatMoney(Math.round(args.amount * 100), account.currencyCode)} ${args.type}` },
          { label: "Account", value: account.name },
          { label: "Category", value: category?.name ?? "Uncategorised" },
          { label: "Date", value: date },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const tx = await createTransactionCore(ctx.userId, payload as never);
      return {
        status: "completed" as ExecStatus,
        title: "Transaction added",
        detail: `${tx.description} · ${formatMoney(tx.amountMinor, tx.currencyCode)}`,
        block: { type: "result", status: "completed", title: "Transaction added", detail: tx.description } as ResponseBlock,
      };
    },
  }),

  write({
    name: "categorise_transaction",
    title: "Categorise transaction",
    description: "Set the category of one transaction (by id) using a category name.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      id: z.string().uuid(),
      category: z.string(),
    }),
    async prepare(ctx, args) {
      const tx = await getTransaction(ctx.userId, args.id);
      if (!tx) throw new Error("Transaction not found.");
      const category = await resolveCategory(ctx.userId, args.category);
      if (!category) throw new Error(`No category matching "${args.category}".`);
      return {
        payload: { id: args.id, categoryId: category.id },
        title: "Change category?",
        summary: tx.description,
        fields: [
          { label: "Transaction", value: tx.description },
          { label: "From", value: tx.category?.name ?? "Uncategorised" },
          { label: "To", value: category.name },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; categoryId: string };
      await updateTransactionCore(ctx.userId, p.id, { categoryId: p.categoryId });
      return { status: "completed" as ExecStatus, title: "Category updated" };
    },
  }),

  write({
    name: "mark_transaction_reviewed",
    title: "Mark reviewed",
    description: "Approve one or more pending/imported transactions into the ledger.",
    risk: "write",
    requiredScope: "reviews:write",
    input: z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }),
    async prepare(_ctx, args) {
      return {
        payload: { ids: args.ids },
        title: "Mark reviewed?",
        summary: `${args.ids.length} transaction(s) will be approved into your ledger.`,
        fields: [{ label: "Count", value: String(args.ids.length) }],
        affectedCount: args.ids.length,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { ids: string[] };
      const r = await approveTransactionsCore(ctx.userId, p);
      return { status: "completed" as ExecStatus, title: `Approved ${r.approved}` };
    },
  }),

  write({
    name: "create_goal",
    title: "Create goal",
    description: "Create a savings goal with a target amount and optional target date.",
    risk: "write",
    requiredScope: "goals:write",
    input: z.object({
      name: z.string().min(1).max(120),
      targetAmount: z.number().positive(),
      currentAmount: z.number().min(0).default(0),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    async prepare(ctx, args) {
      const payload = {
        name: args.name,
        targetAmount: args.targetAmount,
        currentAmount: args.currentAmount,
        currencyCode: ctx.currency,
        targetDate: args.targetDate ?? null,
        accountId: null,
      };
      return {
        payload,
        title: "Create goal?",
        summary: args.name,
        fields: [
          { label: "Target", value: formatMoney(Math.round(args.targetAmount * 100), ctx.currency) },
          ...(args.targetDate ? [{ label: "By", value: args.targetDate }] : []),
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const goal = await createGoalCore(ctx.userId, payload as never);
      return { status: "completed" as ExecStatus, title: "Goal created", detail: goal.name };
    },
  }),

  write({
    name: "bulk_categorise_matching_transactions",
    title: "Bulk categorise",
    description:
      "Categorise every transaction whose description matches a text query. Always shows the exact list before applying.",
    risk: "sensitive",
    requiredScope: "transactions:write",
    input: z.object({
      matchText: z.string().min(1).max(100),
      category: z.string(),
    }),
    async prepare(ctx, args) {
      const category = await resolveCategory(ctx.userId, args.category);
      if (!category) throw new Error(`No category matching "${args.category}".`);
      const { items } = await listTransactions(ctx.userId, {
        q: args.matchText,
        page: 1,
        pageSize: 200,
      } as Parameters<typeof listTransactions>[1]);
      if (items.length === 0) throw new Error(`No transactions match "${args.matchText}".`);
      const ids = items.map((t) => t.id);
      return {
        payload: { ids, categoryId: category.id },
        title: "Recategorise these?",
        summary: `${items.length} transaction(s) matching "${args.matchText}" → ${category.name}.`,
        fields: items.slice(0, 6).map((t) => ({
          label: t.date,
          value: `${t.description} · ${formatMoney(t.amountMinor, t.currencyCode)}`,
        })),
        affectedCount: items.length,
        warning: items.length > 20 ? "This affects a large number of transactions." : undefined,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { ids: string[]; categoryId: string };
      const r = await bulkCategorizeCore(ctx.userId, p);
      return { status: "completed" as ExecStatus, title: `Recategorised ${r.updated}` };
    },
  }),

  write({
    name: "create_rule",
    title: "Create rule",
    description:
      "Save and activate a deterministic rule. Conditions and actions use the same shape as propose_rule. Always call propose_rule first and show the user the dry run; this requires explicit confirmation.",
    risk: "sensitive",
    requiredScope: "rules:write",
    input: ruleInput,
    async prepare(ctx, args) {
      const { definition, conditionLabels, actionLabels } = await resolveRule(ctx, args);
      const preview = await previewRuleDefinition(ctx.userId, {
        matchAll: definition.matchAll,
        conditions: definition.conditions,
        actions: definition.actions.map((a) => ({ type: a.type, value: a.value ?? null })),
      });
      return {
        payload: definition,
        title: "Create this rule?",
        summary: `${definition.name} — ${conditionLabels.map((c) => c.label).join(args.matchAll ? " AND " : " OR ")} → ${actionLabels.map((a) => a.label).join(", ")}.`,
        fields: [
          { label: "When", value: conditionLabels.map((c) => c.label).join(args.matchAll ? " AND " : " OR ") },
          { label: "Then", value: actionLabels.map((a) => a.label).join(", ") },
          { label: "Matches now", value: `${preview.matchedCount} of ${preview.scannedCount} recent` },
        ],
        affectedCount: preview.matchedCount,
        warning: preview.matchedCount > 50 ? "This rule matches a large number of transactions." : undefined,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const rule = await createRuleCore(ctx.userId, payload as CreateRuleInput);
      return {
        status: "completed" as ExecStatus,
        title: "Rule created",
        detail: rule.name,
        block: { type: "result", status: "completed", title: "Rule created", detail: rule.name } as ResponseBlock,
      };
    },
  }),

  write({
    name: "set_rule_active",
    title: "Enable/disable rule",
    description: "Turn an existing rule on or off by id.",
    risk: "write",
    requiredScope: "rules:write",
    input: z.object({ id: z.string().uuid(), active: z.boolean() }),
    async prepare(ctx, args) {
      const rules = await listRulesCore(ctx.userId);
      const rule = rules.find((r) => r.id === args.id);
      if (!rule) throw new Error("Rule not found.");
      return {
        payload: { id: args.id, active: args.active },
        title: args.active ? "Enable rule?" : "Disable rule?",
        summary: rule.name,
        fields: [{ label: "Rule", value: rule.name }, { label: "State", value: args.active ? "Enabled" : "Disabled" }],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; active: boolean };
      const r = await setRuleActiveCore(ctx.userId, p.id, p.active);
      return { status: "completed" as ExecStatus, title: r.isActive ? "Rule enabled" : "Rule disabled", detail: r.name };
    },
  }),

  write({
    name: "run_rule",
    title: "Run rule now",
    description: "Manually execute a stored rule against recent transactions, applying its actions. Shows impact and requires confirmation.",
    risk: "sensitive",
    requiredScope: "rules:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const rules = await listRulesCore(ctx.userId);
      const rule = rules.find((r) => r.id === args.id);
      if (!rule) throw new Error("Rule not found.");
      return {
        payload: { id: args.id },
        title: "Run this rule now?",
        summary: `${rule.name} will be applied to your recent transactions.`,
        fields: [{ label: "Rule", value: rule.name }],
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      const r = await runRuleCore(ctx.userId, p.id);
      return { status: "completed" as ExecStatus, title: `Applied to ${r.applied}`, detail: `${r.matched} matched, ${r.applied} changed` };
    },
  }),
];

/* ── the registry ───────────────────────────────────────────────────────── */

export const TOOLS: Tool[] = [...readTools, ...writeTools];
export const MCP_TOOLS: ReadTool[] = readTools;
export const TOOL_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

export function toolsForScopes(scopes: Scope[]): Tool[] {
  return TOOLS.filter((t) => scopes.includes(t.requiredScope));
}
