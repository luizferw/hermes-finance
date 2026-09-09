import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts,
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  db,
  installmentPlans,
  installments,
  transactions,
  users,
} from "@kosh/db";
import { reconcileBillingCycleCore } from "./mutations";

/**
 * Regression for PRD §29: `reconcileBillingCycle` used to just write whatever
 * total it was handed, with no comparison against what the system itself
 * billed to the cycle. A real statement with a fee or a missed purchase would
 * be silently accepted as reconciled.
 */
const stamp = randomUUID();
const userId = `reconcile_probe_${stamp}`;
let cycleId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Reconcile probe", email: `${userId}@kosh.test` });

  const [cardAccount] = await db
    .insert(accounts)
    .values({ userId, name: `Card ${stamp}`, type: "credit_card", currencyCode: "INR" })
    .returning({ id: accounts.id });

  const [card] = await db
    .insert(creditCards)
    .values({
      userId,
      accountId: cardAccount!.id,
      name: `Card ${stamp}`,
      currencyCode: "INR",
      creditLimitMinor: 500_000,
      defaultClosingDay: 25,
      defaultDueDay: 2,
    })
    .returning({ id: creditCards.id });

  const [cycle] = await db
    .insert(creditCardBillingCycles)
    .values({
      creditCardId: card!.id,
      statementMonth: "2026-09-01",
      openedAt: "2026-08-26",
      dueAt: "2026-10-02",
      status: "open",
    })
    .returning({ id: creditCardBillingCycles.id });
  cycleId = cycle!.id;

  const [tx] = await db
    .insert(transactions)
    .values({
      userId,
      accountId: cardAccount!.id,
      type: "expense",
      date: "2026-09-10",
      amountMinor: -30_000,
      currencyCode: "INR",
      description: "Regression probe purchase",
    })
    .returning({ id: transactions.id });

  const [purchase] = await db
    .insert(creditCardPurchases)
    .values({
      creditCardId: card!.id,
      transactionId: tx!.id,
      purchaseDate: "2026-09-10",
      totalAmountMinor: 30_000,
    })
    .returning({ id: creditCardPurchases.id });

  const [plan] = await db
    .insert(installmentPlans)
    .values({ creditCardPurchaseId: purchase!.id, totalInstallments: 1 })
    .returning({ id: installmentPlans.id });

  // What the system knows it billed to this cycle: a single R$300 purchase.
  await db.insert(installments).values({
    installmentPlanId: plan!.id,
    number: 1,
    amountMinor: 30_000,
    billingCycleId: cycleId,
    expectedAt: "2026-10-02",
    status: "billed",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("reconcileBillingCycleCore", () => {
  it("accepts the requested status when the statement matches what was billed", async () => {
    const result = await reconcileBillingCycleCore(userId, cycleId, { confirmedTotal: 300, status: "paid" });

    expect(result.discrepancyMinor).toBe(0);
    expect(result.status).toBe("paid");

    const row = await db.query.creditCardBillingCycles.findFirst({ where: eq(creditCardBillingCycles.id, cycleId) });
    expect(row?.status).toBe("paid");
    expect(row?.confirmedTotalMinor).toBe(30_000);
  });

  it("forces needs_review when the real statement does not match, regardless of the requested status", async () => {
    // The real statement carries a R$15 fee the system never recorded.
    const result = await reconcileBillingCycleCore(userId, cycleId, { confirmedTotal: 315, status: "paid" });

    expect(result.expectedMinor).toBe(30_000);
    expect(result.confirmedTotalMinor).toBe(31_500);
    expect(result.discrepancyMinor).toBe(1_500);
    expect(result.status).toBe("needs_review");

    const row = await db.query.creditCardBillingCycles.findFirst({ where: eq(creditCardBillingCycles.id, cycleId) });
    expect(row?.status).toBe("needs_review");
  });
});
