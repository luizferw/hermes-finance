import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, creditCards, db, transactions, users } from "@kosh/db";
import { nominalCycleFor } from "@hermes-finance/forecast";
import { todayIso } from "@kosh/domain";
import { buildUserForecastDetailed, getSafeToSpend } from "./queries";

/**
 * Regression for the forecast's most consequential bug: a card imported from a
 * bank export has ledger transactions but no `CreditCardBillingCycle` rows —
 * the forecast used to know nothing about its debt, no matter how large.
 *
 * This reproduces the exact shape that broke: a card account with purchases
 * and zero recorded cycles, checked against `buildUserForecastDetailed`
 * directly (not `getCardStatement`, which already derived correctly before
 * this fix and could not have caught a regression here).
 */
const stamp = randomUUID();
const userId = `ledger_cycle_${stamp}`;
const CLOSING_DAY = 25;
const DUE_DAY = 2;
const PURCHASE_MINOR = 30_000;

let cardAccountId: string;
let creditCardId: string;
let expectedDueAt: string;
let expectedStatementMonth: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Ledger cycle probe", email: `${userId}@kosh.test` });

  const [, card] = await db
    .insert(accounts)
    .values([
      { userId, name: `Asset ${stamp}`, type: "asset", currencyCode: "INR", openingBalanceMinor: 100_000, currentBalanceMinor: 100_000 },
      { userId, name: `Card ${stamp}`, type: "credit_card", currencyCode: "INR", openingBalanceMinor: 0, currentBalanceMinor: -PURCHASE_MINOR },
    ])
    .returning({ id: accounts.id });
  cardAccountId = card!.id;

  const [creditCard] = await db
    .insert(creditCards)
    .values({
      userId,
      accountId: cardAccountId,
      name: `Card ${stamp}`,
      currencyCode: "INR",
      creditLimitMinor: 500_000,
      defaultClosingDay: CLOSING_DAY,
      defaultDueDay: DUE_DAY,
    })
    .returning({ id: creditCards.id });
  creditCardId = creditCard!.id;

  const purchaseDate = todayIso();
  await db.insert(transactions).values({
    userId,
    accountId: cardAccountId,
    type: "expense",
    date: purchaseDate,
    amountMinor: -PURCHASE_MINOR,
    currencyCode: "INR",
    description: "Regression probe purchase",
  });

  const cycle = nominalCycleFor(purchaseDate, CLOSING_DAY, DUE_DAY);
  expectedDueAt = cycle.dueAt;
  expectedStatementMonth = cycle.statementMonth;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("forecast derives billing cycles from the ledger", () => {
  it("includes a card_statement event for a card with no recorded cycle", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 400);
    const statementEvents = forecast.events.filter((event) => event.sourceType === "card_statement");

    expect(statementEvents).toHaveLength(1);
    const event = statementEvents[0]!;
    expect(event.amountMinor).toBe(-PURCHASE_MINOR);
    expect(event.expectedAt).toBe(expectedDueAt);
    expect(event.logicalKey).toBe(`statement:${creditCardId}:${expectedStatementMonth}`);
    // Derived (unreconciled) cycles carry HIGH confidence, never CONFIRMED —
    // that distinction is what keeps an inferred statement from being shown
    // as a reconciled one.
    expect(event.confidence).toBe("HIGH");
  });

  it("lowers safe-to-spend by exactly the derived card debt", async () => {
    const result = await getSafeToSpend(userId, 400);
    // Opening balance is 100_000 from the one liquid account; the only event
    // is the derived statement, due on expectedDueAt.
    expect(result.minimumBalanceMinor).toBe(100_000 - PURCHASE_MINOR);
    expect(result.minimumBalanceDate).toBe(expectedDueAt);
  });

  it("never counts the same purchase through both a recorded and a derived cycle", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 400);
    const keys = forecast.events.map((event) => event.logicalKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(forecast.events.filter((event) => event.logicalKey.includes(expectedStatementMonth))).toHaveLength(1);
  });
});
