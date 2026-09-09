import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bills, db, transactions, users } from "@kosh/db";
import { todayIso } from "@kosh/domain";
import { buildUserForecastDetailed } from "./queries";

/**
 * PRD §9.10, scoped to FIXED vs VARIABLE: a fixed bill always projects at its
 * typed amount; a variable one (energy, water — anything that changes each
 * time) prefers the amount of whichever transaction last actually paid it,
 * and only falls back to the typed guess until that history exists.
 */
const stamp = randomUUID();
const userId = `amount_strategy_${stamp}`;

let fixedBillId: string;
let variableWithHistoryId: string;
let variableNoHistoryId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Amount strategy probe", email: `${userId}@kosh.test` });

  await db
    .insert(accounts)
    .values({ userId, name: `Asset ${stamp}`, type: "asset", currencyCode: "INR", openingBalanceMinor: 100_000, currentBalanceMinor: 100_000 });

  const nextDueDate = todayIso();

  const [fixed] = await db
    .insert(bills)
    .values({
      userId,
      name: "Rent",
      expectedAmountMinor: 100_000,
      currencyCode: "INR",
      recurrence: "monthly",
      amountStrategy: "fixed",
      nextDueDate,
    })
    .returning({ id: bills.id });
  fixedBillId = fixed!.id;

  const [withHistory] = await db
    .insert(bills)
    .values({
      userId,
      name: "Energy",
      expectedAmountMinor: 25_000, // stale manual guess
      currencyCode: "INR",
      recurrence: "monthly",
      amountStrategy: "variable",
      nextDueDate,
    })
    .returning({ id: bills.id });
  variableWithHistoryId = withHistory!.id;

  // The real bill that arrived and was actually paid: R$247.30, not the R$250 guess.
  await db.insert(transactions).values({
    userId,
    accountId: (await db.query.accounts.findFirst({ where: eq(accounts.userId, userId) }))!.id,
    type: "expense",
    date: "2026-08-12",
    amountMinor: -24_730,
    currencyCode: "INR",
    description: "Energy bill",
    billId: variableWithHistoryId,
  });

  const [noHistory] = await db
    .insert(bills)
    .values({
      userId,
      name: "Water",
      expectedAmountMinor: 8_000,
      currencyCode: "INR",
      recurrence: "monthly",
      amountStrategy: "variable",
      nextDueDate,
    })
    .returning({ id: bills.id });
  variableNoHistoryId = noHistory!.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("bill amount strategy", () => {
  it("projects a fixed bill at its typed amount with HIGH confidence", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 5);
    const event = forecast.events.find((item) => item.sourceType === "bill" && item.id.includes(fixedBillId));

    expect(event?.amountMinor).toBe(-100_000);
    expect(event?.confidence).toBe("HIGH");
  });

  it("prefers the last actually-paid amount for a variable bill over its stale typed guess", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 5);
    const event = forecast.events.find((item) => item.sourceType === "bill" && item.id.includes(variableWithHistoryId));

    expect(event?.amountMinor).toBe(-24_730);
    expect(event?.confidence).toBe("MEDIUM");
  });

  it("falls back to the typed guess for a variable bill with no payment history yet, at LOW confidence", async () => {
    const { forecast } = await buildUserForecastDetailed(userId, 5);
    const event = forecast.events.find((item) => item.sourceType === "bill" && item.id.includes(variableNoHistoryId));

    expect(event?.amountMinor).toBe(-8_000);
    expect(event?.confidence).toBe("LOW");
  });
});
