import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bills, creditCards, db, users } from "@kosh/db";
import { nominalCycleFor } from "@hermes-finance/forecast";
import { todayIso } from "@kosh/domain";
import { buildUserForecastDetailed } from "./queries";

/**
 * A bill paid with a credit card does not take cash on its due date.
 *
 * The forecast used to project every bill as a direct cash outflow on
 * `nextDueDate`, ignoring the account behind it. For a card bill that is wrong
 * twice: the money leaves weeks too early, and out of the bank rather than
 * through the statement that actually pays it (PRD R4 — a card charge is an
 * economic expense, the statement is the cash-flow event).
 *
 * The control bill on a bank account pins the other half: nothing here may
 * push a *cash* bill onto a statement.
 */
const stamp = randomUUID();
const userId = `bill_on_card_${stamp}`;
const CLOSING_DAY = 25;
const DUE_DAY = 5;
const CARD_BILL_MINOR = 2_690;
const CASH_BILL_MINOR = 30_000;
const OPENING_MINOR = 100_000;

/** Day 17 of next month: comfortably inside one cycle, in every month. */
function seventeenthOfNextMonth(): string {
  const [year, month] = todayIso().split("-").map(Number) as [number, number];
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-17`;
}

const billDate = seventeenthOfNextMonth();
let creditCardId: string;
let statementDueAt: string;
let statementMonth: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Card bill probe", email: `${userId}@kosh.test` });

  const [bank, card] = await db
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
        userId,
        name: `Card ${stamp}`,
        type: "credit_card",
        currencyCode: "INR",
        openingBalanceMinor: 0,
        currentBalanceMinor: 0,
      },
    ])
    .returning({ id: accounts.id });

  const [creditCard] = await db
    .insert(creditCards)
    .values({
      userId,
      accountId: card!.id,
      name: `Card ${stamp}`,
      currencyCode: "INR",
      creditLimitMinor: 1_000_000,
      defaultClosingDay: CLOSING_DAY,
      defaultDueDay: DUE_DAY,
    })
    .returning({ id: creditCards.id });
  creditCardId = creditCard!.id;

  await db.insert(bills).values([
    {
      userId,
      name: "Streaming on the card",
      expectedAmountMinor: CARD_BILL_MINOR,
      currencyCode: "INR",
      recurrence: "monthly",
      nextDueDate: billDate,
      accountId: card!.id,
      amountStrategy: "fixed",
    },
    {
      userId,
      name: "Electricity from the bank",
      expectedAmountMinor: CASH_BILL_MINOR,
      currencyCode: "INR",
      recurrence: "monthly",
      nextDueDate: billDate,
      accountId: bank!.id,
      amountStrategy: "fixed",
    },
  ]);

  const nominal = nominalCycleFor(billDate, CLOSING_DAY, DUE_DAY);
  statementDueAt = nominal.dueAt;
  statementMonth = nominal.statementMonth;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("a bill charged to a credit card settles through the statement", () => {
  it("never emits a cash event on the card bill's own due date", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 120);
    const onBillDate = forecast.events.filter(
      (event) => event.expectedAt === billDate && event.sourceType === "bill",
    );

    // Only the bank bill. The card bill's due date moves no cash at all.
    expect(onBillDate).toHaveLength(1);
    expect(onBillDate[0]!.amountMinor).toBe(-CASH_BILL_MINOR);
  });

  it("charges it to the cycle that was open when it posts", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 120);
    const statement = forecast.events.find(
      (event) => event.logicalKey === `statement:${creditCardId}:${statementMonth}`,
    );

    expect(statement).toBeDefined();
    expect(statement!.expectedAt).toBe(statementDueAt);
    expect(statement!.amountMinor).toBe(-CARD_BILL_MINOR);
    // The bill is a projection, not a reconciled statement total.
    expect(statement!.confidence).toBe("HIGH");
  });

  it("moves the cash to the statement date rather than dropping it", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 120);
    const balanceOn = (date: string) =>
      forecast.days.find((day) => day.date === date)!.closingBalanceMinor;

    // Both bills fall due on the same day. Only the bank one takes cash then.
    expect(statementDueAt > billDate).toBe(true);
    expect(balanceOn(billDate)).toBe(OPENING_MINOR - CASH_BILL_MINOR);
    // The card bill's money leaves later, when the statement settles — it is
    // deferred, never dropped.
    expect(balanceOn(statementDueAt)).toBe(OPENING_MINOR - CASH_BILL_MINOR - CARD_BILL_MINOR);
  });
});
