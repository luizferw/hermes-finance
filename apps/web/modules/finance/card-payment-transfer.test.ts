import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, creditCards, db, transactions, users } from "@kosh/db";
import { nominalCycleFor } from "@hermes-finance/forecast";
import { todayIso } from "@kosh/domain";
import { buildUserForecastDetailed, getCardStatement } from "./queries";

/**
 * A card statement that has been paid must stop taking cash out of the horizon.
 *
 * Paying the bill from a bank account is a transfer, and a transfer is stored
 * as one row on the *source* account — the destination leg is derived, never
 * written (PRD R5). The forecast derived a card's cycles from rows whose
 * `accountId` was the card, so it saw every purchase and not one payment: a
 * card paid down to zero kept its whole debt, forever.
 *
 * The dates below are deliberate. The payment posts in a *later* billing
 * period than the charge it settles — paying August's bill in September is the
 * normal case, not the exception — which is why a payment can never be matched
 * to a cycle by its own date.
 */
const stamp = randomUUID();
const userId = `card_payment_${stamp}`;
const CLOSING_DAY = 21;
/** After the closing day, so a statement falls due inside its own month. */
const DUE_DAY = 28;
const CHARGE_MINOR = 50_000;
const OPENING_MINOR = 500_000;

/** Day `day` of next month — always ahead of today, in every month. */
function nextMonthOn(day: number): string {
  const [year, month] = todayIso().split("-").map(Number) as [number, number];
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const chargeDate = nextMonthOn(15);
/** Past the closing day, so it lands in the cycle *after* the charge's. */
const paymentDate = nextMonthOn(25);

let paidCardId: string;
let unpaidCardId: string;
let dueAt: string;
let chargeMonth: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Card payment probe", email: `${userId}@kosh.test` });

  const [bank, paidAccount, unpaidAccount] = await db
    .insert(accounts)
    .values([
      {
        userId,
        name: `Bank ${stamp}`,
        type: "asset",
        currencyCode: "INR",
        openingBalanceMinor: OPENING_MINOR,
        currentBalanceMinor: OPENING_MINOR,
      },
      {
        // Charged, then paid in full: the balance the ledger arrives at is zero.
        userId,
        name: `Paid card ${stamp}`,
        type: "credit_card",
        currencyCode: "INR",
        openingBalanceMinor: 0,
        currentBalanceMinor: 0,
      },
      {
        // Charged and never paid: the balance still carries the debt.
        userId,
        name: `Unpaid card ${stamp}`,
        type: "credit_card",
        currencyCode: "INR",
        openingBalanceMinor: 0,
        currentBalanceMinor: -CHARGE_MINOR,
      },
    ])
    .returning({ id: accounts.id });

  const created = await db
    .insert(creditCards)
    .values([
      {
        userId,
        accountId: paidAccount!.id,
        name: `Paid card ${stamp}`,
        currencyCode: "INR",
        creditLimitMinor: 1_000_000,
        defaultClosingDay: CLOSING_DAY,
        defaultDueDay: DUE_DAY,
      },
      {
        userId,
        accountId: unpaidAccount!.id,
        name: `Unpaid card ${stamp}`,
        currencyCode: "INR",
        creditLimitMinor: 1_000_000,
        defaultClosingDay: CLOSING_DAY,
        defaultDueDay: DUE_DAY,
      },
    ])
    .returning({ id: creditCards.id });
  paidCardId = created[0]!.id;
  unpaidCardId = created[1]!.id;

  await db.insert(transactions).values([
    {
      userId,
      accountId: paidAccount!.id,
      type: "expense",
      date: chargeDate,
      amountMinor: -CHARGE_MINOR,
      currencyCode: "INR",
      description: "Charge on the paid card",
    },
    {
      userId,
      accountId: unpaidAccount!.id,
      type: "expense",
      date: chargeDate,
      amountMinor: -CHARGE_MINOR,
      currencyCode: "INR",
      description: "Charge on the unpaid card",
    },
    {
      // Deleted rows are not debt. Without a `deletedAt` filter this doubled
      // the unpaid card's statement.
      userId,
      accountId: unpaidAccount!.id,
      type: "expense",
      date: chargeDate,
      amountMinor: -CHARGE_MINOR,
      currencyCode: "INR",
      description: "Deleted charge",
      deletedAt: new Date(),
    },
    {
      // The payment: one row, on the bank, pointing at the card.
      userId,
      accountId: bank!.id,
      transferAccountId: paidAccount!.id,
      type: "transfer",
      date: paymentDate,
      amountMinor: -CHARGE_MINOR,
      currencyCode: "INR",
      description: "Paid the card bill",
    },
  ]);

  const cycle = nominalCycleFor(chargeDate, CLOSING_DAY, DUE_DAY);
  dueAt = cycle.dueAt;
  chargeMonth = cycle.statementMonth;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("a card bill paid by transfer leaves the horizon", () => {
  it("projects nothing for a card the ledger says is settled", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 200);
    const paid = forecast.events.filter(
      (event) => event.sourceType === "card_statement" && event.logicalKey.includes(paidCardId),
    );

    expect(paid).toHaveLength(0);
    // The payment settles a cycle that closed before it posted, so it is not
    // the two dates lining up that makes this work.
    expect(nominalCycleFor(paymentDate, CLOSING_DAY, DUE_DAY).statementMonth).not.toBe(
      nominalCycleFor(chargeDate, CLOSING_DAY, DUE_DAY).statementMonth,
    );
  });

  it("still projects the card that was never paid", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 200);
    const unpaid = forecast.events.filter(
      (event) => event.sourceType === "card_statement" && event.logicalKey.includes(unpaidCardId),
    );

    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]!.expectedAt).toBe(dueAt);
    // The charge, once — not counting the deleted row alongside it.
    expect(unpaid[0]!.amountMinor).toBe(-CHARGE_MINOR);
  });

  it("never bills more than the card actually owes", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 200);
    const billedMinor = forecast.events
      .filter((event) => event.sourceType === "card_statement")
      .reduce((total, event) => total + Math.abs(event.amountMinor), 0);

    // Two cards, one charge each; only one of them is still owed.
    expect(billedMinor).toBe(CHARGE_MINOR);
  });
});

describe("a derived cycle's status comes from its own dates", () => {
  it("calls the month still being spent in open, not closed", async () => {
    const statement = await getCardStatement(userId, unpaidCardId);
    const cycle = statement!.cycles.find((entry) => entry.statementMonth === chargeMonth)!;

    // The charge is next month, so its cycle has not closed yet.
    expect(cycle.closesAt > todayIso()).toBe(true);
    expect(cycle.status).toBe("open");
    expect(cycle.source).toBe("derived");
  });
});
