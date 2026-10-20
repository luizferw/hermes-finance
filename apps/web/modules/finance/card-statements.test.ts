import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts,
  bills,
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  db,
  installmentPlans,
  installments,
  transactions,
  users,
} from "@kosh/db";
import { addDays, todayIso } from "@kosh/domain";
import { debtPaymentsFromForecast } from "@hermes-finance/planning";
import { addStatementMonths, nominalCycleFor } from "@hermes-finance/forecast";
import {
  buildUserForecastDetailed,
  getCardStatement,
  getUpcomingCardStatements,
  listCardPurchases,
  listOpenInstallmentPlans,
} from "./queries";
import { registerCardPurchaseCore, updateCreditCardCore } from "./mutations";

/**
 * What a card statement in the forecast is made of, and that nothing in it is
 * counted twice.
 *
 * Each card below isolates one finding from the MCP review: a hand-registered
 * purchase whose parcels were added on top of the cycle that already carried
 * them; a recorded cycle re-derived from the ledger once it fell out of the
 * window; a statement whose amount could not be traced to its parts; and
 * instalment plans listed as still open a year after they were paid.
 */
const stamp = randomUUID().slice(0, 8);
const userId = `card_statements_${stamp}`;
const today = todayIso();
const CLOSING = 10;
const DUE = 17;

function monthShift(day: string, months: number): string {
  const month = addStatementMonths(day.slice(0, 7), months);
  return `${month}-${day.slice(8, 10) > "28" ? "28" : day.slice(8, 10)}`;
}

async function makeCard(name: string, balanceMinor: number) {
  const [account] = await db
    .insert(accounts)
    .values({
      userId,
      name: `${name} ${stamp}`,
      type: "credit_card",
      currencyCode: "INR",
      openingBalanceMinor: balanceMinor,
      currentBalanceMinor: balanceMinor,
      limitMinor: 100_000,
      institution: "Old issuer",
    })
    .returning({ id: accounts.id });
  const [card] = await db
    .insert(creditCards)
    .values({
      userId,
      accountId: account!.id,
      name: `${name} ${stamp}`,
      issuer: "Old issuer",
      currencyCode: "INR",
      creditLimitMinor: 100_000,
      defaultClosingDay: CLOSING,
      defaultDueDay: DUE,
    })
    .returning({ id: creditCards.id });
  return { cardId: card!.id, accountId: account!.id };
}

async function charge(accountId: string, amountMinor: number, date: string, description: string) {
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      accountId,
      type: "expense",
      status: "posted",
      date,
      amountMinor: -amountMinor,
      currencyCode: "INR",
      description,
    })
    .returning({ id: transactions.id });
  return row!.id;
}

async function plan(input: {
  cardId: string;
  transactionId: string;
  purchaseDate: string;
  total: number;
  parcels: { number: number; amountMinor: number; expectedAt: string; status: "projected" | "billed"; transactionId?: string }[];
}) {
  const [purchase] = await db
    .insert(creditCardPurchases)
    .values({
      creditCardId: input.cardId,
      transactionId: input.transactionId,
      purchaseDate: input.purchaseDate,
      totalAmountMinor: input.parcels.reduce((total, one) => total + one.amountMinor, 0),
    })
    .returning({ id: creditCardPurchases.id });
  const [created] = await db
    .insert(installmentPlans)
    .values({
      creditCardPurchaseId: purchase!.id,
      totalInstallments: input.total,
      firstInstallmentNumber: input.parcels[0]!.number,
    })
    .returning({ id: installmentPlans.id });
  await db.insert(installments).values(
    input.parcels.map((one) => ({
      installmentPlanId: created!.id,
      number: one.number,
      amountMinor: one.amountMinor,
      expectedAt: one.expectedAt,
      status: one.status,
      transactionId: one.transactionId ?? null,
    })),
  );
  return { planId: created!.id, purchaseId: purchase!.id };
}

let manual: { cardId: string; accountId: string };
let pastDue: { cardId: string; accountId: string };
let composed: { cardId: string; accountId: string };
let older: { cardId: string; accountId: string };
let pastDueMonth: string;
let openStatement: { statementMonth: string; dueAt: string };
let olderPlanId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Card statements probe", email: `${userId}@kosh.test` });
  await db.insert(accounts).values({
    userId,
    name: `Bank ${stamp}`,
    type: "asset",
    currencyCode: "INR",
    openingBalanceMinor: 1_000_000,
    currentBalanceMinor: 1_000_000,
  });

  // A purchase registered by hand: one full-value transaction, its parcels on
  // recorded cycles.
  manual = await makeCard("Manual", 0);
  await registerCardPurchaseCore(userId, {
    creditCardId: manual.cardId,
    purchaseDate: today,
    totalAmount: 100,
    totalInstallments: 3,
    description: "Hand-registered 3x",
  });

  // A recorded cycle for the month open today, already past due — as after the
  // card's due day was changed — with a charge in the ledger for that month.
  pastDue = await makeCard("PastDue", -5_000);
  pastDueMonth = nominalCycleFor(today, CLOSING, DUE).statementMonth;
  await db.insert(creditCardBillingCycles).values({
    creditCardId: pastDue.cardId,
    statementMonth: `${pastDueMonth}-01`,
    openedAt: addDays(today, -40),
    dueAt: addDays(today, -1),
    status: "open",
  });
  await charge(pastDue.accountId, 5_000, today, "Charge on a past-due recorded cycle");

  // An Open Finance-shaped card: 25.000 posted this cycle (one of them parcel 1
  // of a 4x), three projected parcels of 5.000 ahead, a 26.90 bill charged to
  // it, and a provider balance that counts the future parcels.
  composed = await makeCard("Composed", -40_000);
  openStatement = nominalCycleFor(today, CLOSING, DUE);
  await charge(composed.accountId, 20_000, today, "Supermarket");
  const parcelOne = await charge(composed.accountId, 5_000, today, "SOFA 1/4");
  await plan({
    cardId: composed.cardId,
    transactionId: parcelOne,
    purchaseDate: today,
    total: 4,
    parcels: [
      { number: 1, amountMinor: 5_000, expectedAt: openStatement.dueAt, status: "billed", transactionId: parcelOne },
      { number: 2, amountMinor: 5_000, expectedAt: openStatement.dueAt, status: "projected" },
      { number: 3, amountMinor: 5_000, expectedAt: monthShift(openStatement.dueAt, 1), status: "projected" },
      { number: 4, amountMinor: 5_000, expectedAt: monthShift(openStatement.dueAt, 2), status: "projected" },
    ],
  });
  await db.insert(bills).values({
    userId,
    name: "Streaming on the card",
    expectedAmountMinor: 2_690,
    currencyCode: "INR",
    recurrence: "monthly",
    nextDueDate: today,
    accountId: composed.accountId,
    amountStrategy: "fixed",
  });

  // A card with an old plan: parcel 1 billed and long settled, parcel 2 never
  // matched to any charge, parcel 3 still ahead; and a plan wholly in the past.
  older = await makeCard("Older", 0);
  const oldCharge = await charge(older.accountId, 1_000, monthShift(today, -3), "OLD STORE 1/3");
  olderPlanId = (
    await plan({
      cardId: older.cardId,
      transactionId: oldCharge,
      purchaseDate: monthShift(today, -3),
      total: 3,
      parcels: [
        { number: 1, amountMinor: 1_000, expectedAt: monthShift(today, -2), status: "billed", transactionId: oldCharge },
        { number: 2, amountMinor: 1_000, expectedAt: monthShift(today, -1), status: "projected" },
        { number: 3, amountMinor: 1_000, expectedAt: monthShift(today, 1), status: "projected" },
      ],
    })
  ).planId;
  const settledCharge = await charge(older.accountId, 700, monthShift(today, -14), "PAID OFF 1/2");
  await plan({
    cardId: older.cardId,
    transactionId: settledCharge,
    purchaseDate: monthShift(today, -14),
    total: 2,
    parcels: [
      { number: 1, amountMinor: 700, expectedAt: monthShift(today, -13), status: "billed", transactionId: settledCharge },
      { number: 2, amountMinor: 700, expectedAt: monthShift(today, -12), status: "billed", transactionId: settledCharge },
    ],
  });
  await db.insert(creditCardBillingCycles).values({
    creditCardId: older.cardId,
    statementMonth: `${monthShift(today, -2).slice(0, 7)}-01`,
    openedAt: monthShift(today, -3),
    closedAt: monthShift(today, -2),
    dueAt: monthShift(today, -2),
    confirmedTotalMinor: 0,
    source: "pluggy",
    status: "overdue",
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("a purchase registered by hand", () => {
  it("is billed once per statement — the cycle's parcels are not added again", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 400);
    const statements = forecast.events
      .filter((event) => event.logicalKey.startsWith(`statement:${manual.cardId}:`))
      .sort((left, right) => left.expectedAt.localeCompare(right.expectedAt));

    expect(statements.map((event) => event.amountMinor)).toEqual([-3_333, -3_333, -3_334]);
    // The sum is the debt, not twice it.
    expect(statements.reduce((total, event) => total - event.amountMinor, 0)).toBe(10_000);
    for (const event of statements) {
      expect(event.id.startsWith("statement:recorded:")).toBe(true);
      expect(event.logicalKey).toMatch(/^statement:[^:]+:\d{4}-\d{2}$/);
    }
    // Which is what lets the card-usage engine see the payments at all.
    expect(debtPaymentsFromForecast(statements)).toHaveLength(3);
  });
});

describe("a recorded cycle that fell out of the window", () => {
  it("is not re-derived from the ledger under a derived id", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 400);
    const keys = forecast.events.map((event) => event.logicalKey);
    expect(keys).not.toContain(`statement:${pastDue.cardId}:${pastDueMonth}`);
    expect(forecast.events.some((event) => event.id.startsWith(`statement:derived:${pastDue.cardId}:${pastDueMonth}`))).toBe(false);
  });
});

describe("an upcoming statement, taken apart", () => {
  it("adds up to exactly what the forecast settles, from parts a caller can name", async () => {
    const upcoming = await getUpcomingCardStatements(userId, composed.cardId);
    const first = upcoming!.statements.find((entry) => entry.statementMonth === openStatement.statementMonth)!;

    expect(first.dueAt).toBe(openStatement.dueAt);
    expect(first.cycleSource).toBe("derived");
    expect(first.confidence).toBe("HIGH");
    expect(first.confirmedTotalMinor).toBeNull();
    expect(first.components).toEqual(
      expect.arrayContaining([
        { kind: "posted_charges", amountMinor: 25_000 },
        expect.objectContaining({ kind: "installment", amountMinor: 5_000, number: 2, totalInstallments: 4, description: "SOFA 1/4", status: "projected" }),
        expect.objectContaining({ kind: "card_bill", amountMinor: 2_690, name: "Streaming on the card", chargedAt: today }),
      ]),
    );
    expect(first.components).toHaveLength(3);
    expect(first.componentsTotalMinor).toBe(32_690);
    expect(first.amountMinor).toBe(32_690);

    // The same figure the forecast itself carries for that statement.
    const { forecast } = await buildUserForecastDetailed(userId, 120);
    const event = forecast.events.find((one) => one.logicalKey === first.logicalKey)!;
    expect(-event.amountMinor).toBe(first.amountMinor);

    // And the history's derived total plus the parcels and bills is that amount.
    const history = await getCardStatement(userId, composed.cardId);
    const cycle = history!.cycles.find((one) => one.statementMonth === openStatement.statementMonth)!;
    expect(cycle.totalMinor).toBe(25_000);
  });

  it("explains the debt no statement ahead holds as future parcels", async () => {
    const upcoming = await getUpcomingCardStatements(userId, composed.cardId);
    expect(upcoming!.debtUnplaced).toEqual({
      cardId: composed.cardId,
      cardName: `Composed ${stamp}`,
      unplacedMinor: 15_000,
      futureInstallmentsMinor: 15_000,
      unexplainedMinor: 0,
    });
  });
});

describe("open instalment plans", () => {
  it("count a parcel as remaining only while its statement is still ahead", async () => {
    const plans = await listOpenInstallmentPlans(userId);
    const old = plans.find((one) => one.id === olderPlanId)!;
    expect(old).toMatchObject({
      totalInstallments: 3,
      remainingCount: 1,
      paidInstallments: 2,
      lapsedCount: 1,
      nextNumber: 3,
      nextAmountMinor: 1_000,
      remainingTotalMinor: 1_000,
    });
    // A plan whose every statement is behind is not open at all.
    expect(plans.some((one) => one.description === "PAID OFF 1/2")).toBe(false);
    expect(plans.every((one) => (one.nextExpectedAt ?? "") >= today)).toBe(true);
  });
});

describe("card purchases", () => {
  it("filter by text, date and whether anything is still ahead", async () => {
    expect((await listCardPurchases(userId, older.cardId)).map((one) => one.transaction.description).sort()).toEqual([
      "OLD STORE 1/3",
      "PAID OFF 1/2",
    ]);
    expect((await listCardPurchases(userId, older.cardId, { openOnly: true })).map((one) => one.transaction.description)).toEqual([
      "OLD STORE 1/3",
    ]);
    expect((await listCardPurchases(userId, older.cardId, { q: "paid off" })).map((one) => one.transaction.description)).toEqual([
      "PAID OFF 1/2",
    ]);
    expect(await listCardPurchases(userId, older.cardId, { from: today })).toEqual([]);
    const [open] = await listCardPurchases(userId, older.cardId, { openOnly: true });
    expect(open!.installmentPlans[0]).toMatchObject({ remainingCount: 1, remainingTotalMinor: 1_000 });
  });
});

describe("statement history", () => {
  it("never calls a statement with nothing owed overdue", async () => {
    const history = await getCardStatement(userId, older.cardId);
    const zero = history!.cycles.find((one) => one.source === "open_finance")!;
    expect(zero.totalMinor).toBe(0);
    expect(zero.status).toBe("paid");
  });

  it("gives a recorded cycle not closed yet its nominal closing date, not its opening", async () => {
    const history = await getCardStatement(userId, manual.cardId);
    const cycle = history!.cycles.find((one) => one.source === "recorded")!;
    expect(cycle.closesAt).toBe(nominalCycleFor(`${cycle.statementMonth}-01`, CLOSING, DUE).closesAt);
  });
});

describe("updating a card", () => {
  it("keeps the ledger account's limit and institution in step", async () => {
    await updateCreditCardCore(userId, older.cardId, { creditLimit: 1_500, issuer: "New issuer" });
    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, older.accountId) });
    expect(account).toMatchObject({ limitMinor: 150_000, institution: "New issuer" });
    const card = await db.query.creditCards.findFirst({ where: eq(creditCards.id, older.cardId) });
    expect(card).toMatchObject({ creditLimitMinor: 150_000, issuer: "New issuer" });
  });
});
