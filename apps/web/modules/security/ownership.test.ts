import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  accounts,
  aiConversations,
  aiMessages,
  auditLogs,
  categories,
  db,
  recurringTransactions,
  transactions,
  users,
} from "@kosh/db";
import {
  bulkCategorizeCore,
  createTransactionCore,
} from "@/modules/transactions/mutations";
import { getNetWorthSummary } from "@/modules/accounts/queries";
import { getMonthSummaryFor } from "@/modules/reports/queries";

const stamp = randomUUID();
const userA = `own_a_${stamp}`;
const userB = `own_b_${stamp}`;
let accountA: string;
let accountB: string;
let accountEuro: string;
let categoryB: string;
let txA: string;
let txEuro: string;
let conversationB: string;

beforeAll(async () => {
  await db.insert(users).values([
    { id: userA, name: "Owner A", email: `own-a-${stamp}@kosh.test` },
    { id: userB, name: "Owner B", email: `own-b-${stamp}@kosh.test` },
  ]);
  const [a, b, euro] = await db
    .insert(accounts)
    .values([
      { userId: userA, name: `A ${stamp}`, type: "asset", currencyCode: "INR" },
      { userId: userB, name: `B ${stamp}`, type: "asset", currencyCode: "INR" },
      {
        userId: userA,
        name: `A EUR ${stamp}`,
        type: "asset",
        currencyCode: "EUR",
        openingBalanceMinor: 999_000,
        currentBalanceMinor: 999_000,
      },
    ])
    .returning({ id: accounts.id });
  accountA = a!.id;
  accountB = b!.id;
  accountEuro = euro!.id;
  const [cat] = await db
    .insert(categories)
    .values({ userId: userB, name: `B cat ${stamp}` })
    .returning({ id: categories.id });
  categoryB = cat!.id;
  const [conversation] = await db
    .insert(aiConversations)
    .values({ userId: userB, title: `Ownership probe ${stamp}` })
    .returning({ id: aiConversations.id });
  conversationB = conversation!.id;
  const tx = await createTransactionCore(userA, {
    accountId: accountA,
    type: "expense",
    date: "2026-07-01",
    amount: 10,
    description: "ownership probe",
  });
  txA = tx.id;
  txEuro = (
    await createTransactionCore(userA, {
      accountId: accountEuro,
      type: "income",
      date: "2026-07-01",
      amount: 2500,
      description: "foreign-currency probe",
    })
  ).id;
});

afterAll(async () => {
  await db.delete(auditLogs).where(inArray(auditLogs.userId, [userA, userB]));
  await db.delete(transactions).where(inArray(transactions.id, [txA, txEuro]));
  await db.delete(categories).where(eq(categories.id, categoryB));
  await db.delete(accounts).where(inArray(accounts.id, [accountA, accountB, accountEuro]));
  await db.delete(users).where(inArray(users.id, [userA, userB]));
});

describe("ownership guards", () => {
  it("rejects a transaction against another user's account", async () => {
    await expect(
      createTransactionCore(userA, {
        accountId: accountB,
        type: "expense",
        date: "2026-07-01",
        amount: 10,
        description: "cross account",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a transaction with another user's category", async () => {
    await expect(
      createTransactionCore(userA, {
        accountId: accountA,
        type: "expense",
        date: "2026-07-01",
        amount: 10,
        description: "cross category",
        categoryId: categoryB,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects bulk categorize with another user's category", async () => {
    await expect(
      bulkCategorizeCore(userA, { ids: [txA], categoryId: categoryB }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects cross-owner child rows at the database boundary", async () => {
    await expect(
      db.insert(aiMessages).values({
        conversationId: conversationB,
        userId: userA,
        role: "user",
        text: "cross-user message",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(transactions).values({
        userId: userA,
        accountId: accountB,
        type: "expense",
        date: "2026-07-01",
        amountMinor: -100,
        currencyCode: "INR",
        description: "cross-user transaction",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(recurringTransactions).values({
        userId: userA,
        accountId: accountB,
        name: "cross-user recurring",
        type: "expense",
        amountMinor: -100,
        currencyCode: "INR",
        description: "cross-user recurring",
        nextRunDate: "2026-08-01",
      }),
    ).rejects.toThrow();
  });

  it("does not add foreign minor units into default-currency totals", async () => {
    const month = await getMonthSummaryFor(userA, "2026-07-01");
    expect(month).toEqual({ incomeMinor: 0, expenseMinor: 1000, netMinor: -1000 });
    expect((await getNetWorthSummary(userA)).netWorthMinor).toBe(-1000);
  });
});
