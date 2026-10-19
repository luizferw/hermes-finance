/* eslint-disable @typescript-eslint/no-explicit-any -- forModel is untyped JSON (`unknown`); the assertions walk it loosely. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts,
  bills,
  categories,
  creditCardPurchases,
  creditCards,
  db,
  financialReserves,
  installmentPlans,
  installments,
  purchaseItems,
  purchasePlans,
  savingsGoals,
  transactions,
  users,
} from "@kosh/db";
import { todayIso } from "@kosh/domain";
import { getPurchasePlanImpact, getSafeToSpend } from "@/modules/finance/queries";
import type { ReadTool, ToolContext } from "../types";
import { financeReadsTools, METHODOLOGY } from "./finance-reads";

/**
 * Each read tool is executed through its own tool object against an isolated
 * user, and checked against the very query the screen calls, so a tool can
 * never quietly return less (or other numbers) than the UI.
 */
const stamp = randomUUID();
const userId = `finance_reads_${stamp}`;
const ctx: ToolContext = { userId, scopes: ["finance:read"], currency: "INR" };
const today = todayIso();

function plusDays(days: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function tool(name: string): ReadTool {
  const found = financeReadsTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
}

async function run(name: string, args: Record<string, unknown> = {}) {
  const t = tool(name);
  const parsed = t.input.parse(args);
  const result = await t.execute(ctx, parsed);
  return result.forModel as Record<string, any>;
}

let bankId: string;
let cardId: string;
let archivedCardId: string;
let planId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Finance reads probe", email: `${userId}@kosh.test` });
  const [bank] = await db
    .insert(accounts)
    .values({
      userId,
      name: `Bank ${stamp}`,
      type: "asset",
      currencyCode: "INR",
      openingBalanceMinor: 500_000,
      currentBalanceMinor: 500_000,
    })
    .returning({ id: accounts.id });
  bankId = bank!.id;
  const [category] = await db
    .insert(categories)
    .values({ userId, name: `Gadgets ${stamp}` })
    .returning({ id: categories.id });

  const [cardAccount] = await db
    .insert(accounts)
    .values({
      userId,
      name: `Card ${stamp}`,
      type: "credit_card",
      currencyCode: "INR",
      openingBalanceMinor: 0,
      currentBalanceMinor: -30_000,
    })
    .returning({ id: accounts.id });
  const [card] = await db
    .insert(creditCards)
    .values({
      userId,
      accountId: cardAccount!.id,
      name: `Card ${stamp}`,
      currencyCode: "INR",
      creditLimitMinor: 200_000,
      defaultClosingDay: 25,
      defaultDueDay: 5,
      paymentAccountId: bankId,
    })
    .returning({ id: creditCards.id });
  cardId = card!.id;

  const [oldAccount] = await db
    .insert(accounts)
    .values({ userId, name: `Old card ${stamp}`, type: "credit_card", currencyCode: "INR" })
    .returning({ id: accounts.id });
  const [archived] = await db
    .insert(creditCards)
    .values({
      userId,
      accountId: oldAccount!.id,
      name: `Old card ${stamp}`,
      currencyCode: "INR",
      creditLimitMinor: 50_000,
      defaultClosingDay: 10,
      defaultDueDay: 20,
      active: false,
    })
    .returning({ id: creditCards.id });
  archivedCardId = archived!.id;

  // A 3x card purchase entered by hand: one full-value transaction, three projected parcels.
  const [purchaseTx] = await db
    .insert(transactions)
    .values({
      userId,
      accountId: cardAccount!.id,
      type: "expense",
      date: today,
      amountMinor: -30_000,
      currencyCode: "INR",
      description: "Headphones",
      categoryId: category!.id,
    })
    .returning({ id: transactions.id });
  const [purchase] = await db
    .insert(creditCardPurchases)
    .values({
      creditCardId: cardId,
      transactionId: purchaseTx!.id,
      purchaseDate: today,
      categoryId: category!.id,
      merchant: "Sound Shop",
      totalAmountMinor: 30_000,
    })
    .returning({ id: creditCardPurchases.id });
  const [plan] = await db
    .insert(installmentPlans)
    .values({ creditCardPurchaseId: purchase!.id, totalInstallments: 3 })
    .returning({ id: installmentPlans.id });
  await db.insert(installments).values(
    [1, 2, 3].map((number) => ({
      installmentPlanId: plan!.id,
      number,
      amountMinor: 10_000,
      expectedAt: plusDays(30 * number),
      status: "projected" as const,
    })),
  );

  await db.insert(financialReserves).values([
    { userId, name: "Emergency", kind: "hard", amountMinor: 100_000, currencyCode: "INR" },
    { userId, name: "Trip", kind: "soft", amountMinor: 450_000, currencyCode: "INR" },
    { userId, name: "Old floor", kind: "hard", amountMinor: 999_999, currencyCode: "INR", isActive: false },
  ]);

  await db.insert(savingsGoals).values({
    userId,
    name: "Laptop fund",
    targetAmountMinor: 120_000,
    currentAmountMinor: 10_000,
    currencyCode: "INR",
    targetDate: plusDays(180),
    accountId: bankId,
  });

  await db.insert(bills).values({
    userId,
    name: "Internet",
    expectedAmountMinor: 5_000,
    currencyCode: "INR",
    recurrence: "monthly",
    nextDueDate: plusDays(10),
    accountId: bankId,
  });

  const [purchasePlan] = await db
    .insert(purchasePlans)
    .values({ userId, name: "Home office", currencyCode: "INR", budgetMinor: 100_000 })
    .returning({ id: purchasePlans.id });
  planId = purchasePlan!.id;
  await db.insert(purchaseItems).values([
    {
      purchasePlanId: planId,
      name: "Chair",
      estimatedPriceMinor: 60_000,
      purchaseDate: plusDays(3),
      accountId: cardAccount!.id,
      installments: 3,
      status: "planned",
    },
    {
      purchasePlanId: planId,
      name: "Lamp",
      estimatedPriceMinor: 8_000,
      actualPriceMinor: 7_500,
      purchaseDate: today,
      accountId: bankId,
      status: "purchased",
    },
    { purchasePlanId: planId, name: "Desk", estimatedPriceMinor: 50_000, status: "idea" },
    { purchasePlanId: planId, name: "Rug", estimatedPriceMinor: 20_000, isActive: false },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("finance read tools", () => {
  it("get_methodology returns the structured explanation", async () => {
    const result = await run("get_methodology");
    expect(result).toBe(METHODOLOGY);
    expect(result.safeToSpend.rules.length).toBeGreaterThan(0);
    expect(result.purchaseSimulation.cardLimit).toContain("peak usage");
  });

  it("get_safe_to_spend returns every route, the best one and the floor, as the overview does", async () => {
    const result = await run("get_safe_to_spend");
    const expected = await getSafeToSpend(userId, 30);
    expect(result.safeToSpendMinor).toBe(expected.safeToSpendMinor);
    expect(result.floorMinor).toBe(100_000);
    expect(result.hardReserveMinor).toBe(100_000);
    expect(result.bestOption).toEqual(expected.bestOption);
    expect(result.options.map((option: any) => option.label)).toEqual(expected.options.map((o) => o.label));
    expect(result.options.find((option: any) => option.cardId === null).settlementDate).toBe(today);
    expect(result.options.find((option: any) => option.cardId === cardId)).toBeTruthy();
    expect(result.options.filter((option: any) => option.isBest)).toHaveLength(1);
  });

  it("get_projection labels each event", async () => {
    const result = await run("get_projection", { horizonDays: 40 });
    const internet = result.events.find((event: any) => event.sourceType === "bill");
    expect(internet.label).toBe("Internet");
    const statement = result.events.find((event: any) => event.sourceType === "card_statement");
    expect(statement.label).toBe(`Fatura Card ${stamp}`);
    expect(result.days[0]).toHaveProperty("closingBalanceMinor");
  });

  it("get_credit_cards includes the payment account", async () => {
    const result = await run("get_credit_cards");
    const card = result.cards.find((candidate: any) => candidate.id === cardId);
    expect(card.paymentAccountName).toBe(`Bank ${stamp}`);
    expect(card.committedMinor).toBe(30_000);
    expect(card.availableLimitMinor).toBe(170_000);
    expect(result.cards.some((candidate: any) => candidate.id === archivedCardId)).toBe(false);
  });

  it("get_archived_credit_cards lists archived cards only", async () => {
    const result = await run("get_archived_credit_cards");
    expect(result.cards.map((card: any) => card.id)).toEqual([archivedCardId]);
  });

  it("get_card_statement includes closing/due days and payment account", async () => {
    const result = await run("get_card_statement", { cardId });
    expect(result.card.defaultClosingDay).toBe(25);
    expect(result.card.defaultDueDay).toBe(5);
    expect(result.card.paymentAccountName).toBe(`Bank ${stamp}`);
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  it("get_card_purchases returns purchases with category and instalment rows", async () => {
    const result = await run("get_card_purchases", { cardId });
    expect(result.purchases).toHaveLength(1);
    const [purchase] = result.purchases;
    expect(purchase.description).toBe("Headphones");
    expect(purchase.merchant).toBe("Sound Shop");
    expect(purchase.categoryName).toBe(`Gadgets ${stamp}`);
    expect(purchase.totalInstallments).toBe(3);
    expect(purchase.installmentPlans[0].installments.map((row: any) => row.number)).toEqual([1, 2, 3]);
    expect(purchase.installmentPlans[0].installments[0].status).toBe("projected");

    const missing = await run("get_card_purchases", { cardId: randomUUID() });
    expect(missing.error).toBe("not_found");
  });

  it("get_open_installment_plans lists what is still being paid", async () => {
    const result = await run("get_open_installment_plans");
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      cardId,
      description: "Headphones",
      totalInstallments: 3,
      paidInstallments: 0,
      remainingCount: 3,
      nextAmountMinor: 10_000,
      remainingTotalMinor: 30_000,
    });
  });

  it("get_financial_reserves sums only active hard reserves", async () => {
    const result = await run("get_financial_reserves");
    expect(result.reserves).toHaveLength(3);
    expect(result.activeHardReserveMinor).toBe(100_000);
  });

  it("get_future_view returns goal trajectories, commitments and upcoming bills", async () => {
    const result = await run("get_future_view");
    expect(result.goalsActive).toBe(1);
    expect(result.goalsRemainingMinor).toBe(110_000);
    expect(result.billsMonthlyMinor).toBe(5_000);
    expect(result.committedCount).toBe(1);
    const [goal] = result.goals;
    expect(goal.name).toBe("Laptop fund");
    expect(goal.accountName).toBe(`Bank ${stamp}`);
    expect(goal.monthlyNeededMinor).toBeGreaterThan(0);
    expect(goal).toHaveProperty("behindMinor");
    expect(result.upcomingBills.map((bill: any) => bill.name)).toEqual(["Internet"]);
  });

  it("get_purchase_plans and get_purchase_plan carry the totals line", async () => {
    const list = await run("get_purchase_plans");
    const plan = list.plans.find((candidate: any) => candidate.id === planId);
    // Chair 60 000 + Lamp at its actual 7 500 + Desk 50 000; the rug is switched off.
    expect(plan.totals).toEqual({
      estimatedTotalMinor: 117_500,
      budgetMinor: 100_000,
      overBudgetMinor: 17_500,
      underBudgetMinor: 0,
      purchasedTotalMinor: 7_500,
      remainingEstimateMinor: 110_000,
    });
    expect(plan.items.find((item: any) => item.name === "Lamp").accountName).toBe(`Bank ${stamp}`);

    const detail = await run("get_purchase_plan", { id: planId });
    expect(detail.plan.totals).toEqual(plan.totals);
    expect(detail.plan.items[0]).toHaveProperty("simulations");
  });

  it("get_purchase_plan_impact returns what the plan screen shows", async () => {
    const result = await run("get_purchase_plan_impact", { planId, includeDaily: true });
    const impact = (await getPurchasePlanImpact(userId, planId))!;
    const simulation = impact.simulation!;

    expect(result.plan.totals.estimatedTotalMinor).toBe(117_500);
    expect(result.unprojectedItems.map((item: any) => item.name)).toEqual(["Desk"]);
    expect(result.verdict.feasible).toBe(simulation.feasible);
    expect(result.verdict.reasons).toEqual(simulation.reasons);
    expect(result.totalCostMinor).toBe(simulation.totalCostMinor);
    expect(result.minimumBalanceAfterMinor).toBe(simulation.minimumBalanceAfterMinor);
    expect(result.safeToSpendSurplusAfterMinor).toBe(simulation.safeToSpendSurplusAfterMinor);
    expect(result.hardReserveMinor).toBe(100_000);
    expect(result.floorMinor).toBe(0);

    const card = result.cards.find((load: any) => load.cardId === cardId);
    expect(card.planChargedMinor).toBe(60_000);
    expect(card.committedMinor).toBe(30_000);
    expect(card).toHaveProperty("baselinePeakMinor");
    expect(card).toHaveProperty("exceededMinor");

    expect(result.monthlyOutlook).toEqual(simulation.monthlyOutlook);
    const chairRows = result.monthlyOutlook.flatMap((entry: any) => entry.items).filter((row: any) => row.label === "Chair");
    expect(chairRows.map((row: any) => row.installmentNumber)).toEqual([1, 2, 3]);

    expect(result.monthlyBalances[0].withPlan).toHaveProperty("lowMinor");
    expect(result.monthlyBalances[0].withoutPlan).toHaveProperty("closingBalanceMinor");
    expect(result.daily.length).toBe(simulation.forecastAfter.days.length);
    expect(result.daily[0]).toEqual({
      date: today,
      beforeMinor: impact.baseline!.forecast.days[0]!.closingBalanceMinor,
      afterMinor: simulation.forecastAfter.days[0]!.closingBalanceMinor,
    });

    const missing = await run("get_purchase_plan_impact", { planId: randomUUID() });
    expect(missing.error).toBe("not_found");
  });
});
