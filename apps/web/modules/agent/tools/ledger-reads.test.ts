import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accountBalances,
  accounts,
  automationRuleActions,
  automationRuleConditions,
  automationRules,
  automationRuns,
  bills,
  budgetCategories,
  budgetPeriods,
  budgets,
  categories,
  confidenceSnapshots,
  db,
  importFiles,
  importMappings,
  importRows,
  recurringTransactions,
  savingsGoals,
  tags,
  transactionMetadata,
  transactionSplits,
  transactionTags,
  transactions,
  userSettings,
  users,
} from "@kosh/db";
import { addMonthsClamped, monthRange, todayIso } from "@kosh/domain";
import { ledgerReadsTools } from "./ledger-reads";
import type { ReadTool, ToolContext } from "../types";

/**
 * Every ledger read tool against an isolated user with one of everything the
 * Kosh screens show. The fixture is small enough that the expected figures can
 * be read off it directly.
 */
const stamp = randomUUID();
const userId = `ledger_reads_${stamp}`;
const ctx: ToolContext = {
  userId,
  scopes: ["finance:read", "rules:read", "automations:read"],
  currency: "BRL",
};
const today = todayIso();
const { start: monthStart } = monthRange(today);
const lastMonth = monthRange(addMonthsClamped(today, -1)).start;

const ids = {} as Record<string, string>;

function tool(name: string): ReadTool {
  const found = ledgerReadsTools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function run<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
  const t = tool(name);
  const result = await t.execute(ctx, t.input.parse(args));
  return result as { forModel: T; block?: { type: string } };
}

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Ledger reads probe", email: `${userId}@kosh.test` });
  await db.insert(userSettings).values({
    userId,
    country: "BR",
    currencyCode: "BRL",
    locale: "pt-BR",
    dateFormat: "dd/MM/yyyy",
    financialYearStartMonth: 1,
  });

  const [bank, card, old] = await db
    .insert(accounts)
    .values([
      {
        userId,
        name: `Banco ${stamp}`,
        type: "asset",
        currencyCode: "BRL",
        institution: "Nubank",
        accountNumberMask: "1234",
        openingBalanceMinor: 100_000,
        openingBalanceDate: lastMonth,
        currentBalanceMinor: 100_000,
      },
      {
        userId,
        name: `Cartao ${stamp}`,
        type: "credit_card",
        currencyCode: "BRL",
        limitMinor: 500_000,
        currentBalanceMinor: -20_000,
      },
      { userId, name: `Antiga ${stamp}`, type: "asset", currencyCode: "BRL", isArchived: true },
    ])
    .returning({ id: accounts.id });
  ids.bank = bank!.id;
  ids.card = card!.id;
  ids.old = old!.id;
  await db.insert(accountBalances).values([
    { accountId: ids.bank, date: lastMonth, balanceMinor: 100_000, currencyCode: "BRL" },
    { accountId: ids.bank, date: today, balanceMinor: 100_000, currencyCode: "BRL" },
  ]);

  const [food, salary] = await db
    .insert(categories)
    .values([
      { userId, name: "Mercado" },
      { userId, name: "Salario" },
    ])
    .returning({ id: categories.id });
  ids.food = food!.id;
  ids.salary = salary!.id;
  const [tag] = await db.insert(tags).values({ userId, name: "casa" }).returning({ id: tags.id });
  ids.tag = tag!.id;

  const [file] = await db
    .insert(importFiles)
    .values({ userId, accountId: ids.bank, fileName: "extrato.csv", status: "committed", rowCount: 2 })
    .returning({ id: importFiles.id });
  ids.file = file!.id;

  const [income, grocery, dupe, rejected, transfer] = await db
    .insert(transactions)
    .values([
      {
        userId,
        accountId: ids.bank,
        type: "income",
        status: "posted",
        date: monthStart,
        amountMinor: 500_000,
        currencyCode: "BRL",
        description: "Salario ACME",
        categoryId: ids.salary,
      },
      {
        userId,
        accountId: ids.bank,
        type: "expense",
        status: "posted",
        date: today,
        valueDate: today,
        amountMinor: -12_345,
        currencyCode: "BRL",
        description: "Supermercado Zona Sul",
        merchant: "Zona Sul",
        rawDescription: "PIX ZONA SUL 123",
        narration: "secret narration",
        notes: "weekly shop",
        upiReference: "UPI-1",
        utrNumber: "UTR-1",
        externalId: "ext-1",
        categoryId: ids.food,
      },
      {
        userId,
        accountId: ids.bank,
        type: "expense",
        status: "imported",
        date: today,
        amountMinor: -12_345,
        currencyCode: "BRL",
        description: "ZONA SUL",
        importFileId: ids.file,
      },
      {
        userId,
        accountId: ids.bank,
        type: "expense",
        status: "rejected",
        date: today,
        amountMinor: -999,
        currencyCode: "BRL",
        description: "Rejected thing",
      },
      {
        userId,
        accountId: ids.bank,
        transferAccountId: ids.card,
        type: "transfer",
        status: "posted",
        date: today,
        amountMinor: -5_000,
        currencyCode: "BRL",
        description: "Pagamento fatura",
      },
    ])
    .returning({ id: transactions.id });
  ids.income = income!.id;
  ids.grocery = grocery!.id;
  ids.dupe = dupe!.id;
  ids.rejected = rejected!.id;
  ids.transfer = transfer!.id;
  await db.update(transactions).set({ suspectedDuplicateOfId: ids.grocery }).where(eq(transactions.id, ids.dupe));
  await db.insert(transactionTags).values({ transactionId: ids.grocery, tagId: ids.tag });
  await db.insert(transactionSplits).values([
    { transactionId: ids.grocery, categoryId: ids.food, amountMinor: -10_000, description: "food" },
    { transactionId: ids.grocery, categoryId: null, amountMinor: -2_345, description: "other" },
  ]);
  await db.insert(transactionMetadata).values({ transactionId: ids.grocery, key: "nsu", value: "42" });

  await db.insert(importRows).values([
    {
      importFileId: ids.file,
      rowIndex: 0,
      raw: { data: today, valor: "-123.45" },
      status: "duplicate",
      parsedDate: today,
      parsedAmountMinor: -12_345,
      parsedDescription: "ZONA SUL",
      duplicateOfTransactionId: ids.grocery,
    },
    { importFileId: ids.file, rowIndex: 1, raw: { data: "x" }, status: "error", parseError: "bad date" },
  ]);
  await db.insert(importMappings).values({
    userId,
    name: "Nubank",
    mapping: { date: "data", amount: "valor", description: "descricao" },
    dateFormat: "yyyy-MM-dd",
  });

  const [rule] = await db
    .insert(automationRules)
    .values({ userId, name: "Mercado rule", description: "groceries", priority: 1 })
    .returning({ id: automationRules.id });
  ids.rule = rule!.id;
  await db.insert(automationRuleConditions).values([
    { ruleId: ids.rule, field: "description_contains", value: "zona sul" },
    { ruleId: ids.rule, field: "amount_greater_than", value: "10000" },
    { ruleId: ids.rule, field: "account_is", value: ids.bank },
  ]);
  await db.insert(automationRuleActions).values([
    { ruleId: ids.rule, type: "set_category", value: ids.food },
    { ruleId: ids.rule, type: "add_tag", value: ids.tag },
  ]);
  await db.insert(automationRuns).values({ ruleId: ids.rule, userId, trigger: "manual", matchedCount: 3, appliedCount: 1 });

  await db.insert(bills).values([
    {
      userId,
      name: "Luz",
      expectedAmountMinor: 15_000,
      currencyCode: "BRL",
      nextDueDate: today,
      accountId: ids.bank,
      categoryId: ids.food,
      amountStrategy: "variable",
      notes: "enel",
    },
    { userId, name: "Gym", expectedAmountMinor: 9_000, currencyCode: "BRL", nextDueDate: today, isActive: false },
  ]);
  await db.insert(recurringTransactions).values([
    {
      userId,
      name: "Aluguel",
      type: "transfer",
      accountId: ids.bank,
      transferAccountId: ids.card,
      amountMinor: -200_000,
      currencyCode: "BRL",
      description: "Aluguel mensal",
      nextRunDate: today,
    },
    {
      userId,
      name: "Old sub",
      type: "expense",
      accountId: ids.bank,
      amountMinor: -1_000,
      currencyCode: "BRL",
      description: "Old",
      nextRunDate: today,
      isActive: false,
    },
  ]);

  const [budget, archived] = await db
    .insert(budgets)
    .values([
      { userId, name: "Comida" },
      { userId, name: "Velho", isArchived: true },
    ])
    .returning({ id: budgets.id });
  ids.budget = budget!.id;
  ids.archivedBudget = archived!.id;
  await db.insert(budgetCategories).values({ budgetId: ids.budget, categoryId: ids.food });
  await db.insert(budgetPeriods).values({
    budgetId: ids.budget,
    periodStart: monthStart,
    periodEnd: monthRange(today).end,
    plannedAmountMinor: 100_000,
    currencyCode: "BRL",
  });

  await db.insert(savingsGoals).values({
    userId,
    name: "Viagem",
    targetAmountMinor: 200_000,
    currentAmountMinor: 50_000,
    currencyCode: "BRL",
    accountId: ids.bank,
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("ledger read tools", () => {
  it("searches the ledger with the UI's filters and paging", async () => {
    const all = await run<{ total: number; transactions: Array<{ id: string; tags: string[] }> }>("search_transactions");
    expect(all.forModel.total).toBe(5);

    const byAccount = await run<{
      total: number;
      transactions: Array<{ id: string; transferAccount: { name: string } | null }>;
    }>("search_transactions", { account: `Cartao ${stamp}` });
    // The card is only the destination of the transfer.
    expect(byAccount.forModel.total).toBe(1);
    expect(byAccount.forModel.transactions[0]!.id).toBe(ids.transfer);

    const filtered = await run<{ total: number; transactions: Array<{ id: string; tags: string[]; rawDescription: string }> }>(
      "search_transactions",
      { category: "Mercado", status: "posted", minAmount: 100, maxAmount: 200, q: "zona" },
    );
    expect(filtered.forModel.total).toBe(1);
    expect(filtered.forModel.transactions[0]).toMatchObject({ id: ids.grocery, tags: ["casa"], rawDescription: "PIX ZONA SUL 123" });

    const paged = await run<{ total: number; pageCount: number; transactions: unknown[] }>("search_transactions", {
      page: 2,
      pageSize: 2,
    });
    expect(paged.forModel.pageCount).toBe(3);
    expect(paged.forModel.transactions).toHaveLength(2);

    await expect(run("search_transactions", { account: "nope-nope" })).rejects.toThrow(/No account/);
  });

  it("returns the full detail sheet, decrypted", async () => {
    const { forModel } = await run<Record<string, unknown>>("get_transaction", { id: ids.grocery });
    expect(forModel).toMatchObject({
      narration: "secret narration",
      notes: "weekly shop",
      upiReference: "UPI-1",
      utrNumber: "UTR-1",
      externalId: "ext-1",
      source: "Manual entry",
      metadata: [{ key: "nsu", value: "42" }],
    });
    expect(forModel.splits).toHaveLength(2);
    const dupe = await run<Record<string, unknown>>("get_transaction", { id: ids.dupe });
    expect(dupe.forModel.source).toBe("Imported from extrato.csv");
    const missing = await run<{ error?: string }>("get_transaction", { id: randomUUID() });
    expect(missing.forModel.error).toBe("not_found");
  });

  it("lists the inbox with duplicate context and the rejected tab", async () => {
    const inbox = await run<{
      totalAwaitingReview: number;
      items: Array<{ id: string; importFileName: string | null; suspectedDuplicateOf: { id: string; amountMinor: number } | null }>;
    }>("get_review_inbox");
    expect(inbox.forModel.totalAwaitingReview).toBe(1);
    expect(inbox.forModel.items[0]).toMatchObject({
      id: ids.dupe,
      importFileName: "extrato.csv",
      suspectedDuplicateOf: { id: ids.grocery, amountMinor: -12_345 },
    });
    const rejected = await run<{ transactions: Array<{ id: string }> }>("get_rejected_transactions");
    expect(rejected.forModel.transactions.map((t) => t.id)).toEqual([ids.rejected]);
  });

  it("explains rules with resolved names, runs and suggestions", async () => {
    const rules = await run<{
      rules: Array<{ summary: string; lastRun: { matched: number; applied: number } | null; conditions: Array<{ label: string }> }>;
    }>("list_rules");
    const [rule] = rules.forModel.rules;
    expect(rule!.summary).toContain(`account is Banco ${stamp}`);
    expect(rule!.summary).toContain("categorise as Mercado");
    expect(rule!.summary).toContain("add tag casa");
    expect(rule!.lastRun).toMatchObject({ matched: 3, applied: 1 });
    expect(rules.block?.type).toBe("ruleList");

    const runs = await run<{ runs: Array<{ rule: string | null; trigger: string }> }>("get_rule_runs", { limit: 5 });
    expect(runs.forModel.runs[0]).toMatchObject({ rule: "Mercado rule", trigger: "manual" });

    const suggestions = await run<{ suggestions: unknown[] }>("get_rule_suggestions");
    expect(Array.isArray(suggestions.forModel.suggestions)).toBe(true);
  });

  it("covers accounts, one account and its balance history", async () => {
    const active = await run<{ accounts: Array<{ id: string }>; netWorth: { netWorthMinor: number } }>("get_accounts");
    expect(active.forModel.accounts.map((a) => a.id)).not.toContain(ids.old);
    expect(active.forModel.netWorth.netWorthMinor).toBe(100_000 - 20_000);
    const withArchived = await run<{ accounts: Array<{ id: string; isArchived: boolean }> }>("get_accounts", {
      includeArchived: true,
    });
    expect(withArchived.forModel.accounts.find((a) => a.id === ids.old)?.isArchived).toBe(true);

    const card = await run<{
      limitKind: string;
      recentTransactions: Array<{ id: string; direction: string; effectiveAmountMinor: number }>;
    }>("get_account", { accountId: ids.card });
    expect(card.forModel.limitKind).toBe("credit_limit");
    expect(card.forModel.recentTransactions[0]).toMatchObject({
      id: ids.transfer,
      direction: "incoming",
      effectiveAmountMinor: 5_000,
    });

    const history = await run<{ points: unknown[] }>("get_account_balance_history", { accountId: ids.bank });
    expect(history.forModel.points).toHaveLength(2);
    const stranger = await run<{ error?: string }>("get_account", { accountId: randomUUID() });
    expect(stranger.forModel.error).toBe("not_found");
  });

  it("reports cash flow, net worth, monthly flows, patterns and the financial year", async () => {
    const cash = await run<{ inflowMinor: number; outflowMinor: number; points: unknown[] }>("get_cash_flow", { days: 7 });
    expect(cash.block?.type).toBe("cashflow");
    expect(cash.forModel.points.length).toBeGreaterThanOrEqual(7);
    expect(cash.forModel.outflowMinor).toBe(12_345 + 12_345); // posted + imported; transfer and rejected excluded

    const series = await run<{ points: Array<{ netWorthMinor: number }> }>("get_net_worth_series");
    expect(series.forModel.points.at(-1)?.netWorthMinor).toBe(100_000);

    const flows = await run<{ flows: Array<{ incomeMinor: number }> }>("get_monthly_flows", { months: 2 });
    expect(flows.forModel.flows.at(-1)?.incomeMinor).toBe(500_000);

    const patterns = await run<{ thisMonthSpendMinor: number; whereItGoes: Array<{ name: string }> }>("get_patterns");
    expect(patterns.forModel.thisMonthSpendMinor).toBe(24_690);
    expect(patterns.forModel.whereItGoes.map((w) => w.name)).toContain("Mercado");

    const fy = await run<{ incomeMinor: number; savingsRatePct: number }>("get_financial_year_summary");
    expect(fy.forModel.incomeMinor).toBe(500_000);
  });

  it("reads confidence without writing a snapshot", async () => {
    const { forModel } = await run<{ score: number; band: string; trend: Array<{ date: string; score: number }> }>(
      "get_confidence",
    );
    expect(forModel.score).toBeGreaterThanOrEqual(0);
    expect(forModel.trend.at(-1)).toEqual({ date: today, score: forModel.score });
    const stored = await db.select().from(confidenceSnapshots).where(eq(confidenceSnapshots.userId, userId));
    expect(stored).toHaveLength(0);
  });

  it("lists bills, recurring, budgets, archived budgets and goals in full", async () => {
    const billsOut = await run<{ bills: Array<{ name: string; state: string; amountStrategy: string }> }>("get_bills");
    expect(billsOut.forModel.bills).toHaveLength(2);
    expect(billsOut.forModel.bills.find((b) => b.name === "Luz")?.state).toBe("due_soon");
    expect(billsOut.forModel.bills.find((b) => b.name === "Gym")?.state).toBe("inactive");
    expect(billsOut.forModel.bills.find((b) => b.name === "Luz")?.amountStrategy).toBe("variable");

    const recurring = await run<{ recurring: Array<{ name: string; transferAccount: { name: string | null } | null }> }>(
      "get_recurring_transactions",
    );
    expect(recurring.forModel.recurring).toHaveLength(2);
    expect(recurring.forModel.recurring.find((r) => r.name === "Aluguel")?.transferAccount?.name).toBe(`Cartao ${stamp}`);
    expect(recurring.block?.type).toBe("recurring");

    const budgetsOut = await run<{
      totals: Array<{ plannedMinor: number; spentMinor: number }>;
      budgets: Array<{ categories: Array<{ name: string }>; spentMinor: number }>;
    }>("get_budgets");
    expect(budgetsOut.block?.type).toBe("budgets");
    expect(budgetsOut.forModel.budgets[0]!.categories[0]!.name).toBe("Mercado");
    expect(budgetsOut.forModel.totals[0]).toEqual({ currency: "BRL", plannedMinor: 100_000, spentMinor: 12_345 });

    const archived = await run<{ budgets: Array<{ id: string }> }>("get_archived_budgets");
    expect(archived.forModel.budgets.map((b) => b.id)).toEqual([ids.archivedBudget]);

    const goals = await run<{ goals: Array<{ account: { name: string } | null; percent: number; remainingMinor: number }> }>(
      "get_goals",
    );
    expect(goals.forModel.goals[0]).toMatchObject({ percent: 25, remainingMinor: 150_000, account: { name: `Banco ${stamp}` } });
    expect(goals.block?.type).toBe("goals");
  });

  it("exposes imports, settings, system health and open finance", async () => {
    const files = await run<{ files: Array<{ id: string; fileName: string }> }>("get_import_files");
    expect(files.forModel.files[0]).toMatchObject({ id: ids.file, fileName: "extrato.csv" });
    const mappings = await run<{ mappings: Array<{ name: string }> }>("get_import_mappings");
    expect(mappings.forModel.mappings[0]!.name).toBe("Nubank");
    const preview = await run<{
      counts: Record<string, number>;
      rows: Array<{ duplicateOf: { id: string } | null; parseError: string | null }>;
    }>("get_import_file", { id: ids.file });
    expect(preview.forModel.counts).toEqual({ duplicate: 1, error: 1 });
    expect(preview.forModel.rows[0]!.duplicateOf?.id).toBe(ids.grocery);
    expect(preview.forModel.rows[1]!.parseError).toBe("bad date");

    const settings = await run<{ currencyCode: string; financialYearStartMonth: number }>("get_settings");
    expect(settings.forModel).toMatchObject({ currencyCode: "BRL", financialYearStartMonth: 1 });

    const health = await run<{ checks: unknown[]; version: string }>("get_system_health");
    expect(health.forModel.checks.length).toBeGreaterThan(0);

    const of = await run<{ enabled: boolean; connections: unknown[]; syncRuns: unknown[]; linkTargets: Array<{ id: string }> }>(
      "get_open_finance_status",
    );
    expect(of.forModel.enabled).toBe(false);
    expect(of.forModel.connections).toEqual([]);
    expect(of.forModel.linkTargets.map((t) => t.id)).not.toContain(ids.old);
  });
});
