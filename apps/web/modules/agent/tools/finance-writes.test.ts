import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  bills,
  budgetPeriods,
  budgets,
  categories,
  creditCardPurchases,
  creditCards,
  db,
  financialReserves,
  installmentPlans,
  recurringTransactions,
  savingsGoals,
  transactions,
  users,
} from "@kosh/db";
import { todayIso } from "@kosh/domain";
import { getCardStatement, getFinancePosition } from "@/modules/finance/queries";
import type { Scope, ToolContext } from "../types";
import { financeWritesReadTools, financeWritesTools } from "./finance-writes";

/**
 * Every planning-screen action the MCP surface exposes, driven end to end
 * through the tool objects (input parse → prepare → execute) against an
 * isolated user, so a tool that resolves the wrong record or skips the Core
 * fails here rather than in a conversation.
 */
const stamp = randomUUID();
const userId = `finance_writes_${stamp}`;
const ctx: ToolContext = {
  userId,
  currency: "BRL",
  scopes: ["finance:read", "plans:write", "goals:write", "transactions:write"] as Scope[],
};

let bankId: string;
let cardAccountId: string;

async function run(name: string, args: Record<string, unknown>) {
  const tool = financeWritesTools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const prepared = await tool.prepare(ctx, tool.input.parse(args));
  const result = await tool.execute(ctx, prepared.payload, randomUUID());
  expect(result.status).toBe("completed");
  return { prepared, result };
}

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Finance writes probe", email: `${userId}@kosh.test` });
  const [bank] = await db
    .insert(accounts)
    .values({ userId, name: `Bank ${stamp}`, type: "asset", currencyCode: "BRL" })
    .returning({ id: accounts.id });
  bankId = bank!.id;
  const [cardAccount] = await db
    .insert(accounts)
    .values({
      userId,
      name: `Gold ${stamp}`,
      type: "credit_card",
      currencyCode: "BRL",
      institution: "Inter",
      limitMinor: 500_000,
    })
    .returning({ id: accounts.id });
  cardAccountId = cardAccount!.id;
  await db.insert(categories).values([
    { userId, name: `Groceries ${stamp}` },
    { userId, name: `Utilities ${stamp}` },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("cards", () => {
  let cardId: string;

  it("create_credit_card inherits name, issuer and limit from the account", async () => {
    await run("create_credit_card", {
      account: `Gold ${stamp}`,
      closingDay: 25,
      dueDay: 5,
      paidFrom: `Bank ${stamp}`,
    });
    const card = await db.query.creditCards.findFirst({ where: eq(creditCards.userId, userId) });
    expect(card).toMatchObject({
      accountId: cardAccountId,
      name: `Gold ${stamp}`,
      issuer: "Inter",
      creditLimitMinor: 500_000,
      defaultClosingDay: 25,
      defaultDueDay: 5,
      paymentAccountId: bankId,
      currencyCode: "BRL",
    });
    cardId = card!.id;
  });

  it("refuses to link the same account twice", async () => {
    const tool = financeWritesTools.find((t) => t.name === "create_credit_card")!;
    await expect(
      tool.prepare(ctx, tool.input.parse({ account: `Gold ${stamp}`, closingDay: 1, dueDay: 10 })),
    ).rejects.toThrow(/already tracked/);
  });

  it("update_credit_card changes only what is passed", async () => {
    await run("update_credit_card", { id: cardId, creditLimit: 6000, dueDay: 7 });
    const card = await db.query.creditCards.findFirst({ where: eq(creditCards.id, cardId) });
    expect(card).toMatchObject({ creditLimitMinor: 600_000, defaultDueDay: 7, defaultClosingDay: 25 });
  });

  it("register_card_purchase creates the expense and parcels summing to the total", async () => {
    const { result } = await run("register_card_purchase", {
      cardId,
      description: "Notebook",
      amount: 100,
      installments: 3,
      purchaseDate: todayIso(),
      category: `Groceries ${stamp}`,
    });
    expect(result.detail).toMatch(/3\/3/);
    const purchase = await db.query.creditCardPurchases.findFirst({
      where: eq(creditCardPurchases.creditCardId, cardId),
      with: { installmentPlans: { with: { installments: true } } },
    });
    expect(purchase!.totalAmountMinor).toBe(10_000);
    const parcels = purchase!.installmentPlans[0]!.installments;
    expect(parcels).toHaveLength(3);
    expect(parcels.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(10_000);
    const tx = await db.query.transactions.findFirst({ where: eq(transactions.id, purchase!.transactionId) });
    expect(tx).toMatchObject({ amountMinor: -10_000, accountId: cardAccountId, description: "Notebook" });
  });

  it("reconcile_billing_cycle accepts a matching total and flags a mismatch", async () => {
    const statement = await getCardStatement(userId, cardId);
    const cycle = statement!.cycles.find((c) => c.source === "recorded" && c.chargesMinor > 0)!;
    const { result: ok } = await run("reconcile_billing_cycle", {
      cardId,
      statementMonth: cycle.statementMonth,
      confirmedTotal: cycle.chargesMinor / 100,
    });
    expect(ok.detail).toMatch(/status closed/);
    const { result: off } = await run("reconcile_billing_cycle", {
      cardId,
      cycleId: cycle.id,
      confirmedTotal: cycle.chargesMinor / 100 + 5,
    });
    expect(off.detail).toMatch(/status needs_review.*discrepancy 500/);
  });

  it("delete_card_purchase removes the expense and every parcel", async () => {
    const purchase = await db.query.creditCardPurchases.findFirst({
      where: eq(creditCardPurchases.creditCardId, cardId),
    });
    await run("delete_card_purchase", { purchaseId: purchase!.id });
    expect(await db.query.transactions.findFirst({ where: eq(transactions.id, purchase!.transactionId) })).toBeUndefined();
    expect(
      await db.query.installmentPlans.findFirst({ where: eq(installmentPlans.creditCardPurchaseId, purchase!.id) }),
    ).toBeUndefined();
  });

  it("archive_credit_card and restore_credit_card toggle the card", async () => {
    await run("archive_credit_card", { id: cardId });
    expect((await db.query.creditCards.findFirst({ where: eq(creditCards.id, cardId) }))!.active).toBe(false);
    await run("restore_credit_card", { id: cardId });
    expect((await db.query.creditCards.findFirst({ where: eq(creditCards.id, cardId) }))!.active).toBe(true);
  });
});

describe("bills", () => {
  let billId: string;

  it("create_bill shows a card-account bill settling via the statement", async () => {
    const { prepared } = await run("create_bill", {
      name: `Streaming ${stamp}`,
      amount: 39.9,
      account: `Gold ${stamp}`,
      category: `Utilities ${stamp}`,
      nextDueDate: "2030-01-10",
    });
    expect(prepared.fields.find((f) => f.label === "Settles via")?.value).toMatch(/statement/);
    const bill = await db.query.bills.findFirst({ where: eq(bills.userId, userId) });
    expect(bill).toMatchObject({
      expectedAmountMinor: 3_990,
      currencyCode: "BRL",
      recurrence: "monthly",
      amountStrategy: "fixed",
      dueDay: 10,
      accountId: cardAccountId,
    });
    billId = bill!.id;
  });

  it("update_bill pauses and switches to a cash account", async () => {
    await run("update_bill", { id: billId, isActive: false, amountStrategy: "variable", account: `Bank ${stamp}` });
    const bill = await db.query.bills.findFirst({ where: eq(bills.id, billId) });
    expect(bill).toMatchObject({ isActive: false, amountStrategy: "variable", accountId: bankId });
  });

  it("get_bill_payment_candidates lists unlinked expenses on the bill's account", async () => {
    await db.insert(transactions).values({
      userId,
      accountId: bankId,
      type: "expense",
      date: todayIso(),
      amountMinor: -4_200,
      currencyCode: "BRL",
      description: "Streaming charge",
    });
    const tool = financeWritesReadTools.find((t) => t.name === "get_bill_payment_candidates")!;
    const out = (await tool.execute(ctx, tool.input.parse({ billId }))).forModel as {
      candidates: Array<{ description: string; amountMinor: number }>;
    };
    expect(out.candidates).toEqual([expect.objectContaining({ description: "Streaming charge", amountMinor: -4_200 })]);
  });

  it("mark_bill_paid with an amount records the payment and advances the due date", async () => {
    await run("mark_bill_paid", { id: billId, amount: 41.5, paymentDate: "2030-01-09" });
    const bill = await db.query.bills.findFirst({ where: eq(bills.id, billId) });
    expect(bill).toMatchObject({ nextDueDate: "2030-02-10", lastPaidDate: "2030-01-09" });
    const paid = await db.query.transactions.findFirst({ where: eq(transactions.billId, billId) });
    expect(paid).toMatchObject({ amountMinor: -4_150, accountId: bankId, date: "2030-01-09" });
  });

  it("delete_bill removes it", async () => {
    await run("delete_bill", { id: billId });
    expect(await db.query.bills.findFirst({ where: eq(bills.id, billId) })).toBeUndefined();
  });
});

describe("recurring", () => {
  let id: string;

  it("create, update, pause and delete a transfer", async () => {
    await run("create_recurring", {
      name: `Card payment ${stamp}`,
      type: "transfer",
      account: `Bank ${stamp}`,
      transferAccount: `Gold ${stamp}`,
      amount: 500,
      nextRunDate: "2030-01-05",
    });
    const created = await db.query.recurringTransactions.findFirst({
      where: eq(recurringTransactions.userId, userId),
    });
    expect(created).toMatchObject({
      type: "transfer",
      accountId: bankId,
      transferAccountId: cardAccountId,
      amountMinor: -50_000,
      description: `Card payment ${stamp}`,
    });
    id = created!.id;

    await run("update_recurring", { id, type: "income", amount: 1200 });
    expect(await db.query.recurringTransactions.findFirst({ where: eq(recurringTransactions.id, id) })).toMatchObject({
      type: "income",
      amountMinor: 120_000,
      transferAccountId: null,
    });

    await run("set_recurring_active", { id, isActive: false });
    expect((await db.query.recurringTransactions.findFirst({ where: eq(recurringTransactions.id, id) }))!.isActive).toBe(false);

    await run("delete_recurring", { id });
    expect(await db.query.recurringTransactions.findFirst({ where: eq(recurringTransactions.id, id) })).toBeUndefined();
  });
});

describe("budgets", () => {
  it("create, update, archive and restore", async () => {
    await run("create_budget", { name: `Food ${stamp}`, amount: 850, categories: [`Groceries ${stamp}`] });
    const budget = await db.query.budgets.findFirst({
      where: eq(budgets.userId, userId),
      with: { budgetCategories: true },
    });
    expect(budget!.budgetCategories).toHaveLength(1);

    await run("update_budget", {
      id: budget!.id,
      amount: 900,
      categories: [`Groceries ${stamp}`, `Utilities ${stamp}`],
    });
    const period = await db.query.budgetPeriods.findFirst({ where: eq(budgetPeriods.budgetId, budget!.id) });
    expect(period).toMatchObject({ plannedAmountMinor: 90_000, currencyCode: "BRL" });

    await run("archive_budget", { id: budget!.id });
    expect((await db.query.budgets.findFirst({ where: eq(budgets.id, budget!.id) }))!.isArchived).toBe(true);
    await run("restore_budget", { name: `Food ${stamp}` });
    expect((await db.query.budgets.findFirst({ where: eq(budgets.id, budget!.id) }))!.isArchived).toBe(false);
  });
});

describe("goals", () => {
  it("create with an account, update, contribute and delete", async () => {
    await run("create_goal", { name: `Trip ${stamp}`, targetAmount: 1000, account: `Bank ${stamp}`, currencyCode: "brl" });
    const goal = await db.query.savingsGoals.findFirst({ where: eq(savingsGoals.userId, userId) });
    expect(goal).toMatchObject({ accountId: bankId, currencyCode: "BRL", targetAmountMinor: 100_000 });

    await run("update_goal", { id: goal!.id, targetAmount: 800, targetDate: "2030-12-31" });
    const { result } = await run("contribute_to_goal", { id: goal!.id, amount: 800 });
    expect(result.detail).toMatch(/80000\/80000 minor.*achieved/);
    await run("contribute_to_goal", { id: goal!.id, amount: -1000 });
    expect(await db.query.savingsGoals.findFirst({ where: eq(savingsGoals.id, goal!.id) })).toMatchObject({
      currentAmountMinor: 0,
      achievedAt: null,
      targetDate: "2030-12-31",
    });

    await run("delete_goal", { id: goal!.id });
    expect(await db.query.savingsGoals.findFirst({ where: eq(savingsGoals.id, goal!.id) })).toBeUndefined();
  });
});

describe("reserves", () => {
  it("create, switch off and delete", async () => {
    await run("create_financial_reserve", { name: `Emergency ${stamp}`, amount: 2000 });
    const reserve = await db.query.financialReserves.findFirst({ where: eq(financialReserves.userId, userId) });
    expect(reserve).toMatchObject({ kind: "hard", amountMinor: 200_000, isActive: true, currencyCode: "BRL" });

    await run("update_financial_reserve", { id: reserve!.id, isActive: false, kind: "soft" });
    expect(await db.query.financialReserves.findFirst({ where: eq(financialReserves.id, reserve!.id) })).toMatchObject({
      isActive: false,
      kind: "soft",
      amountMinor: 200_000,
    });

    await run("delete_financial_reserve", { id: reserve!.id });
    expect(await db.query.financialReserves.findFirst({ where: eq(financialReserves.id, reserve!.id) })).toBeUndefined();
  });
});

describe("balance snapshot", () => {
  it("record_balance_snapshot becomes the account's observed balance in the position", async () => {
    await run("record_balance_snapshot", { account: `Bank ${stamp}`, balance: 1234.56 });
    const snapshot = await db.query.balanceSnapshots.findFirst({
      where: and(eq(balanceSnapshots.userId, userId), eq(balanceSnapshots.accountId, bankId)),
    });
    expect(snapshot).toMatchObject({ amountMinor: 123_456, source: "manual", observedAt: todayIso() });
    const position = await getFinancePosition(userId);
    expect(position.accounts.find((a) => a.id === bankId)).toMatchObject({
      balanceMinor: 123_456,
      source: "snapshot",
    });
  });
});
