import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  db,
  installmentPlans,
  installments,
  openFinanceAccountLinks,
  openFinanceConnections,
  openFinanceSyncRuns,
  transactionMetadata,
  transactions,
  users,
} from "@kosh/db";
import { nominalCycleDueDates } from "@hermes-finance/forecast";
import type {
  PluggyAccount,
  PluggyBill,
  PluggyClient,
  PluggyTransaction,
} from "@hermes-finance/open-finance";
import { repairInstallmentPlans } from "./cards";
import { syncConnection } from "./sync";

/**
 * One purchase, one plan — whatever order its parcels arrive in, however often
 * the sync re-reads them, and whatever an older sync already left behind.
 *
 * The shapes reproduced here are the ones found in real data: an Inter card
 * where "AMAZON MARKETPLACE" 12x had a plan starting at parcel 1 and another at
 * parcel 2, both billing the same parcel-2 charge and both projecting the ten
 * parcels after it, so every future statement counted them twice.
 */
const stamp = randomUUID().slice(0, 8);
const userId = `installment_repair_${stamp}`;
const ITEM_ID = randomUUID();
const NOW = () => new Date("2026-10-15T12:00:00.000Z");
// Inter's real cycle: closes on the 30th, due on the 7th.
const CLOSING = 30;
const DUE = 7;

function stubClient(input: {
  transactions?: PluggyTransaction[];
  bills?: PluggyBill[];
  card?: Partial<PluggyAccount>;
}): PluggyClient {
  return {
    async getItem() {
      return {
        id: ITEM_ID,
        connector: { id: 77, name: "Banco Parcela", imageUrl: null, primaryColor: null },
        status: "UPDATED",
        executionStatus: "SUCCESS",
        lastUpdatedAt: "2026-10-15T09:00:00.000Z",
        consentExpiresAt: null,
        errorCode: null,
      };
    },
    async listAccounts() {
      return [
        {
          id: "card",
          itemId: ITEM_ID,
          type: "CREDIT",
          subtype: "CREDIT_CARD",
          number: "6547",
          name: "Cartão Parcela",
          marketingName: null,
          balance: 0,
          currencyCode: "BRL",
          creditData: {
            brand: "MASTERCARD",
            balanceCloseDate: "2026-09-30",
            balanceDueDate: "2026-10-07",
            creditLimit: 15000,
            availableCreditLimit: 15000,
            minimumPayment: null,
          },
          ...input.card,
        } as PluggyAccount,
      ];
    },
    async listTransactions() {
      return input.transactions ?? [];
    },
    async listBills() {
      return input.bills ?? [];
    },
  };
}

function parcel(id: string, n: number, total: number, amount: number, date: string): PluggyTransaction {
  return {
    id,
    accountId: "card",
    description: "AMAZON MARKETPLACE     SAO PAULO     BRA",
    descriptionRaw: null,
    currencyCode: "BRL",
    amount,
    date: `${date}T00:00:00.000Z`,
    category: "Shopping",
    type: "DEBIT",
    status: "POSTED",
    merchantName: null,
    paymentReason: null,
    creditCardMetadata: {
      installmentNumber: n,
      totalInstallments: total,
      totalAmount: null,
      cardNumber: null,
      billId: null,
    },
  };
}

async function freshConnection(): Promise<string> {
  await db.delete(openFinanceConnections).where(eq(openFinanceConnections.userId, userId));
  const owned = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
  if (owned.length > 0) {
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(balanceSnapshots).where(eq(balanceSnapshots.userId, userId));
    await db.delete(accounts).where(inArray(accounts.id, owned.map((row) => row.id)));
  }
  const [connection] = await db
    .insert(openFinanceConnections)
    .values({ userId, itemId: ITEM_ID, connectorName: "Banco Parcela" })
    .returning({ id: openFinanceConnections.id });
  return connection!.id;
}

async function sync(connectionId: string, input: Parameters<typeof stubClient>[0]) {
  const summary = await syncConnection(userId, connectionId, {
    trigger: "manual",
    client: stubClient(input),
    now: NOW,
  });
  expect(summary.status).toBe("ok");
  return summary;
}

async function theCard() {
  const link = await db.query.openFinanceAccountLinks.findFirst({
    where: and(
      eq(openFinanceAccountLinks.userId, userId),
      eq(openFinanceAccountLinks.providerAccountId, "card"),
    ),
  });
  const card = await db.query.creditCards.findFirst({
    where: eq(creditCards.accountId, link!.accountId!),
  });
  return card!;
}

/** Every plan on the card, with its parcels in order. */
async function plansOf(creditCardId: string) {
  const plans = await db
    .select({
      id: installmentPlans.id,
      purchaseId: creditCardPurchases.id,
      first: installmentPlans.firstInstallmentNumber,
      total: installmentPlans.totalInstallments,
    })
    .from(installmentPlans)
    .innerJoin(creditCardPurchases, eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId))
    .where(eq(creditCardPurchases.creditCardId, creditCardId));
  return Promise.all(
    plans.map(async (plan) => ({
      ...plan,
      parcels: await db
        .select({
          number: installments.number,
          status: installments.status,
          amountMinor: installments.amountMinor,
          expectedAt: installments.expectedAt,
          transactionId: installments.transactionId,
        })
        .from(installments)
        .where(eq(installments.installmentPlanId, plan.id))
        .orderBy(asc(installments.number)),
    })),
  );
}

async function ledgerSnapshot() {
  return db
    .select({ id: transactions.id, amountMinor: transactions.amountMinor, deletedAt: transactions.deletedAt })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(asc(transactions.id));
}

beforeEach(async () => {
  await db
    .insert(users)
    .values({ id: userId, name: "Installment repair probe", email: `${userId}@kosh.test` })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("a parcel the sync reads again", () => {
  it("stays on the plan it joined instead of opening a second plan", async () => {
    const connectionId = await freshConnection();
    const p1 = parcel("amz-1", 1, 12, 92.14, "2026-09-03");
    const p2 = parcel("amz-2", 2, 12, 92.08, "2026-10-04");

    await sync(connectionId, { transactions: [p1] });
    await sync(connectionId, { transactions: [p1, p2] });
    // The window is re-read on every run. This third read is the one that,
    // before the fix, found parcel 2 no longer projected and opened a plan for it.
    const third = await sync(connectionId, { transactions: [p1, p2] });

    // The repair would hide a regression here by merging the duplicate after
    // the fact, so the run itself must report it had nothing to merge.
    const [run] = await db
      .select({ stats: openFinanceSyncRuns.stats })
      .from(openFinanceSyncRuns)
      .where(eq(openFinanceSyncRuns.id, third.runId!));
    expect(run!.stats.installmentPlansMerged).toBeUndefined();

    const plans = await plansOf((await theCard()).id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.first).toBe(1);
    expect(plans[0]!.parcels).toHaveLength(12);
    expect(plans[0]!.parcels.filter((one) => one.status === "billed").map((one) => one.number)).toEqual([1, 2]);
  });
});

describe("parcels arriving newest first across syncs", () => {
  it("extend the plan backwards rather than opening a second one", async () => {
    const connectionId = await freshConnection();
    // The first sync's window only reached parcel 2; a later one reaches back
    // to parcel 1 (a re-link, a longer backfill).
    await sync(connectionId, { transactions: [parcel("amz-2", 2, 12, 92.08, "2026-10-04")] });
    await sync(connectionId, {
      transactions: [parcel("amz-2", 2, 12, 92.08, "2026-10-04"), parcel("amz-1", 1, 12, 92.14, "2026-09-03")],
    });
    const [run] = await db
      .select({ stats: openFinanceSyncRuns.stats })
      .from(openFinanceSyncRuns)
      .where(eq(openFinanceSyncRuns.userId, userId))
      .orderBy(desc(openFinanceSyncRuns.startedAt))
      .limit(1);
    expect(run!.stats.installmentPlansMerged).toBeUndefined();

    const card = await theCard();
    const plans = await plansOf(card.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.first).toBe(1);
    expect(plans[0]!.parcels.map((one) => one.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(plans[0]!.parcels.slice(0, 2).every((one) => one.status === "billed")).toBe(true);
    expect(plans[0]!.parcels[0]!.expectedAt).toBe("2026-10-07");

    const [purchase] = await db
      .select({ purchaseDate: creditCardPurchases.purchaseDate })
      .from(creditCardPurchases)
      .where(eq(creditCardPurchases.creditCardId, card.id));
    expect(purchase!.purchaseDate).toBe("2026-09-03");
  });
});

/**
 * Plans as the pre-fix sync wrote them, inserted directly: the repair has to
 * heal data that already exists, not just data the fixed sync would produce.
 */
async function bookParcel(accountId: string, n: number, total: number, amountMinor: number, date: string) {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      type: "expense",
      status: "imported",
      date,
      amountMinor: -amountMinor,
      currencyCode: "BRL",
      description: `PARCEL ${n}/${total}`,
      externalId: `legacy-${randomUUID()}`,
    })
    .returning({ id: transactions.id });
  await db.insert(transactionMetadata).values({
    transactionId: row!.id,
    key: "open_finance.installment",
    value: `${n}/${total}`,
  });
  return row!.id;
}

async function legacyPlan(input: {
  creditCardId: string;
  purchaseTransactionId: string;
  purchaseDate: string;
  total: number;
  first: number;
  amountMinor: number;
  billed: Record<number, string>;
}) {
  const [purchase] = await db
    .insert(creditCardPurchases)
    .values({
      creditCardId: input.creditCardId,
      transactionId: input.purchaseTransactionId,
      purchaseDate: input.purchaseDate,
      totalAmountMinor: input.amountMinor * input.total,
    })
    .returning({ id: creditCardPurchases.id });
  const [plan] = await db
    .insert(installmentPlans)
    .values({ creditCardPurchaseId: purchase!.id, totalInstallments: input.total, firstInstallmentNumber: input.first })
    .returning({ id: installmentPlans.id });
  const dueDates = nominalCycleDueDates(input.purchaseDate, CLOSING, DUE, input.total - input.first + 1);
  await db.insert(installments).values(
    dueDates.map((expectedAt, index) => {
      const number = input.first + index;
      const transactionId = input.billed[number];
      return {
        installmentPlanId: plan!.id,
        number,
        amountMinor: input.amountMinor,
        expectedAt,
        status: transactionId ? ("billed" as const) : ("projected" as const),
        transactionId: transactionId ?? null,
      };
    }),
  );
  return plan!.id;
}

describe("repairing duplicate plans an older sync left behind", () => {
  it("folds every shape found in real data into one plan per purchase, touching no transaction", async () => {
    const connectionId = await freshConnection();
    await sync(connectionId, {});
    const card = await theCard();
    const accountId = card.accountId;

    // AMAZON 12x: plan from parcel 1, and a second plan opened by parcel 2,
    // which also billed parcel 2 of the first.
    const amz1 = await bookParcel(accountId, 1, 12, 9214, "2026-09-03");
    const amz2 = await bookParcel(accountId, 2, 12, 9208, "2026-10-04");
    const amazonKeep = await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: amz1, purchaseDate: "2026-09-03",
      total: 12, first: 1, amountMinor: 9214, billed: { 1: amz1, 2: amz2 },
    });
    await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: amz2, purchaseDate: "2026-10-04",
      total: 12, first: 2, amountMinor: 9208, billed: { 2: amz2 },
    });

    // FRIGELARC 12x: the duplicate (from parcel 3) went on to bill parcel 4,
    // which the original still projects.
    const fr1 = await bookParcel(accountId, 1, 12, 18849, "2026-07-06");
    const fr2 = await bookParcel(accountId, 2, 12, 18845, "2026-08-06");
    const fr3 = await bookParcel(accountId, 3, 12, 18845, "2026-09-08");
    const fr4 = await bookParcel(accountId, 4, 12, 18845, "2026-10-08");
    const frigelarcKeep = await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: fr1, purchaseDate: "2026-07-06",
      total: 12, first: 1, amountMinor: 18849, billed: { 1: fr1, 2: fr2, 3: fr3 },
    });
    await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: fr3, purchaseDate: "2026-09-08",
      total: 12, first: 3, amountMinor: 18845, billed: { 3: fr3, 4: fr4 },
    });

    // Three plans for one 6x purchase.
    const pi1 = await bookParcel(accountId, 1, 6, 3583, "2026-08-24");
    const pi2 = await bookParcel(accountId, 2, 6, 3579, "2026-09-24");
    const pi3 = await bookParcel(accountId, 3, 6, 3583, "2026-10-12");
    const pichauKeep = await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: pi1, purchaseDate: "2026-08-24",
      total: 6, first: 1, amountMinor: 3583, billed: { 1: pi1, 2: pi2 },
    });
    await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: pi2, purchaseDate: "2026-09-24",
      total: 6, first: 2, amountMinor: 3579, billed: { 2: pi2, 3: pi3 },
    });
    await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: pi3, purchaseDate: "2026-10-12",
      total: 6, first: 3, amountMinor: 3583, billed: { 3: pi3 },
    });

    // Two genuinely separate purchases of the same thing, same day: each
    // parcel 1 is its own charge, so they must stay two plans.
    const twinA = await bookParcel(accountId, 1, 3, 5000, "2026-10-02");
    const twinB = await bookParcel(accountId, 1, 3, 5000, "2026-10-02");
    await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: twinA, purchaseDate: "2026-10-02",
      total: 3, first: 1, amountMinor: 5000, billed: { 1: twinA },
    });
    await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: twinB, purchaseDate: "2026-10-02",
      total: 3, first: 1, amountMinor: 5000, billed: { 1: twinB },
    });

    const ledgerBefore = await ledgerSnapshot();

    // The repair runs inside every sync; nothing has to call it by hand.
    const summary = await sync(connectionId, {});
    expect(summary.status).toBe("ok");

    const plans = await plansOf(card.id);
    expect(plans).toHaveLength(5);

    const amazon = plans.find((plan) => plan.id === amazonKeep)!;
    expect(amazon.parcels.map((one) => [one.number, one.status, one.transactionId])).toEqual([
      [1, "billed", amz1],
      [2, "billed", amz2],
      ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, "projected", null]),
    ]);

    const frigelarc = plans.find((plan) => plan.id === frigelarcKeep)!;
    expect(frigelarc.parcels.filter((one) => one.status === "billed").map((one) => one.transactionId)).toEqual([
      fr1, fr2, fr3, fr4,
    ]);
    expect(frigelarc.parcels.filter((one) => one.status === "projected")).toHaveLength(8);

    const pichau = plans.find((plan) => plan.id === pichauKeep)!;
    expect(pichau.parcels.map((one) => one.transactionId)).toEqual([pi1, pi2, pi3, null, null, null]);

    expect(plans.filter((plan) => plan.total === 3)).toHaveLength(2);

    // Ten projected parcels of 92.14 ahead, not twenty.
    const projectedAhead = plans
      .flatMap((plan) => plan.parcels)
      .filter((one) => one.status === "projected").length;
    expect(projectedAhead).toBe(10 + 8 + 3 + 2 + 2);

    // Every purchase row still points at a live transaction, and the ledger is
    // byte-for-byte what it was.
    expect(await ledgerSnapshot()).toEqual(ledgerBefore);
    const purchases = await db
      .select({ id: creditCardPurchases.id })
      .from(creditCardPurchases)
      .where(eq(creditCardPurchases.creditCardId, card.id));
    expect(purchases).toHaveLength(5);

    // Idempotent: the second pass has nothing left to do.
    const again = await db.transaction((trx) => repairInstallmentPlans(trx, userId));
    expect(again).toEqual({ plansMerged: 0, parcelsLinked: 0, zeroCyclesSettled: 0 });
  });

  it("links a booked parcel no plan ever claimed", async () => {
    const connectionId = await freshConnection();
    await sync(connectionId, {});
    const card = await theCard();
    const first = await bookParcel(card.accountId, 1, 4, 2500, "2026-08-10");
    const plan = await legacyPlan({
      creditCardId: card.id, purchaseTransactionId: first, purchaseDate: "2026-08-10",
      total: 4, first: 1, amountMinor: 2500, billed: { 1: first },
    });
    // Booked, 30 cents off the projection, and left unlinked by an older sync.
    const third = await bookParcel(card.accountId, 3, 4, 2530, "2026-10-10");

    const repaired = await db.transaction((trx) => repairInstallmentPlans(trx, userId));
    expect(repaired.parcelsLinked).toBe(1);

    const [only] = (await plansOf(card.id)).filter((one) => one.id === plan);
    expect(only!.parcels.map((one) => [one.number, one.status, one.amountMinor])).toEqual([
      [1, "billed", 2500],
      [2, "projected", 2500],
      [3, "billed", 2530],
      [4, "projected", 2500],
    ]);
    expect(only!.parcels[2]!.transactionId).toBe(third);
  });
});

describe("provider bills", () => {
  const bill = (id: string, closedAt: string | null, dueAt: string, total: number): PluggyBill => ({
    id,
    dueDate: `${dueAt}T00:00:00.000Z`,
    billClosingDate: closedAt ? `${closedAt}T00:00:00.000Z` : null,
    totalAmount: total,
    totalAmountCurrencyCode: "BRL",
    minimumPaymentAmount: null,
    payments: [],
  });

  it("call a closed bill with nothing owed paid, never overdue", async () => {
    const connectionId = await freshConnection();
    await sync(connectionId, { bills: [bill("zero", "2026-08-30", "2026-09-07", 0)] });
    const cycles = await db
      .select({ status: creditCardBillingCycles.status })
      .from(creditCardBillingCycles)
      .where(eq(creditCardBillingCycles.creditCardId, (await theCard()).id));
    expect(cycles.map((cycle) => cycle.status)).toEqual(["paid"]);
  });

  it("correct a card whose configured days contradict every bill it published", async () => {
    const connectionId = await freshConnection();
    // Configured from the provider's stale description: closing 25, due 2.
    const stale = {
      creditData: {
        brand: "VISA",
        balanceCloseDate: "2026-09-25",
        balanceDueDate: "2026-10-02",
        creditLimit: 200,
        availableCreditLimit: 200,
        minimumPayment: null,
      },
    } as Partial<PluggyAccount>;
    await sync(connectionId, { card: stale });
    expect(await theCard()).toMatchObject({ defaultClosingDay: 25, defaultDueDay: 2 });

    // Every bill it actually publishes closes on the 1st and is due on the 10th.
    const bills = [
      bill("aug", "2026-08-01", "2026-08-10", 120),
      bill("sep", "2026-09-01", "2026-09-10", 80),
      bill("oct", "2026-10-01", "2026-10-10", 50),
    ];
    await sync(connectionId, { card: stale, bills });
    const card = await theCard();
    expect(card).toMatchObject({ defaultClosingDay: 1, defaultDueDay: 10 });

    // One cycle per bill, still, after a second run with the corrected days.
    await sync(connectionId, { card: stale, bills });
    const cycles = await db
      .select({ statementMonth: creditCardBillingCycles.statementMonth, dueAt: creditCardBillingCycles.dueAt })
      .from(creditCardBillingCycles)
      .where(eq(creditCardBillingCycles.creditCardId, card.id))
      .orderBy(asc(creditCardBillingCycles.dueAt));
    expect(cycles).toEqual([
      { statementMonth: "2026-08-01", dueAt: "2026-08-10" },
      { statementMonth: "2026-09-01", dueAt: "2026-09-10" },
      { statementMonth: "2026-10-01", dueAt: "2026-10-10" },
    ]);
  });

  it("leave days alone when a bill only drifted around a weekend", async () => {
    const connectionId = await freshConnection();
    await sync(connectionId, {
      bills: [bill("feb", "2026-02-27", "2026-03-09", 10), bill("mar", "2026-03-30", "2026-04-07", 10)],
    });
    expect(await theCard()).toMatchObject({ defaultClosingDay: CLOSING, defaultDueDay: DUE });
  });
});
