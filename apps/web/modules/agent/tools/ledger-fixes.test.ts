/* eslint-disable @typescript-eslint/no-explicit-any -- forModel is untyped JSON (`unknown`); the assertions walk it loosely. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts,
  bills,
  categories,
  db,
  tags,
  transactionMetadata,
  transactionTags,
  transactions,
  userSettings,
  users,
} from "@kosh/db";
import { addDays, addMonthsClamped, monthRange, todayIso } from "@kosh/domain";
import { TOOL_BY_NAME } from "../registry";
import type { ReadTool, ToolContext, WriteTool } from "../types";

/**
 * Regressions from the MCP test sessions on the ledger, reporting and system
 * tools: silent fallbacks, truncated or unlabelled figures, and counts that
 * disagreed with what actually happened. One isolated user, removed (with
 * everything it owns, by cascade) in afterAll.
 */
const stamp = randomUUID();
const userId = `ledger_fixes_${stamp}`;
const ctx: ToolContext = {
  userId,
  currency: "BRL",
  scopes: [
    "finance:read",
    "rules:read",
    "rules:write",
    "transactions:write",
    "reviews:write",
    "plans:write",
    "settings:write",
  ],
};
const today = todayIso();
const lastMonthDay = monthRange(addMonthsClamped(today, -1)).start;
const ids = {} as Record<string, string>;

async function read<T = Record<string, any>>(name: string, args: Record<string, unknown> = {}) {
  const t = TOOL_BY_NAME.get(name) as ReadTool;
  if (!t) throw new Error(`missing tool ${name}`);
  return (await t.execute(ctx, t.input.parse(args))).forModel as T;
}

async function prepare(name: string, args: Record<string, unknown>) {
  const t = TOOL_BY_NAME.get(name) as WriteTool;
  if (!t) throw new Error(`missing tool ${name}`);
  return t.prepare(ctx, t.input.parse(args));
}

async function write(name: string, args: Record<string, unknown>) {
  const t = TOOL_BY_NAME.get(name) as WriteTool;
  const prepared = await prepare(name, args);
  return t.execute(ctx, prepared.payload, randomUUID()) as Promise<{ title: string; detail?: string; data?: any }>;
}

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Ledger fixes probe", email: `${userId}@kosh.test` });
  // An Indian default country with Brazilian money, as onboarding left it for the real user.
  await db.insert(userSettings).values({ userId, country: "IN", currencyCode: "BRL", locale: "pt-BR" });
  const [bank, wallet] = await db
    .insert(accounts)
    .values([
      // Overdrawn current account: the net liquid balance is negative.
      { userId, name: `Conta ${stamp}`, type: "asset", currencyCode: "BRL", currentBalanceMinor: -457_200 },
      { userId, name: `Carteira ${stamp}`, type: "wallet", currencyCode: "BRL", currentBalanceMinor: 15_000 },
    ])
    .returning({ id: accounts.id });
  ids.bank = bank!.id;
  ids.wallet = wallet!.id;

  const [market, fun, home] = await db
    .insert(categories)
    .values([
      { userId, name: "Mercado" },
      { userId, name: "Lazer" },
      { userId, name: "Casa" },
    ])
    .returning({ id: categories.id });
  ids.market = market!.id;
  ids.fun = fun!.id;
  ids.home = home!.id;
  const [tag] = await db.insert(tags).values({ userId, name: "viagem" }).returning({ id: tags.id });
  ids.tag = tag!.id;

  const base = { userId, accountId: ids.bank, type: "expense" as const, currencyCode: "BRL", date: today };
  const [groceries, cinema, homeGoods, pending, synced, utility] = await db
    .insert(transactions)
    .values([
      { ...base, amountMinor: -10_000, description: "GIASSI SUPERMERCADO", categoryId: ids.market },
      { ...base, amountMinor: -5_000, description: "CINEMA", categoryId: ids.fun },
      { ...base, amountMinor: -2_000, description: "GIASSI LAR", categoryId: ids.home },
      { ...base, amountMinor: -700, description: "PENDING THING", status: "pending" as const },
      { ...base, amountMinor: -3_000, description: "PIX PLUGGY" },
      { ...base, amountMinor: -2_690, description: "UNIFIQUE", date: lastMonthDay, categoryId: ids.home },
    ])
    .returning({ id: transactions.id });
  ids.groceries = groceries!.id;
  ids.cinema = cinema!.id;
  ids.homeGoods = homeGoods!.id;
  ids.pending = pending!.id;
  ids.synced = synced!.id;
  ids.utility = utility!.id;
  await db.insert(transactionTags).values({ transactionId: ids.homeGoods, tagId: ids.tag });
  await db.insert(transactionMetadata).values({ transactionId: ids.synced, key: "open_finance.provider", value: "pluggy" });

  const [bill] = await db
    .insert(bills)
    .values({
      userId,
      name: "Internet",
      expectedAmountMinor: 2_690,
      currencyCode: "BRL",
      nextDueDate: addDays(today, 5),
      accountId: ids.bank,
    })
    .returning({ id: bills.id });
  ids.bill = bill!.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("account names fail loudly", () => {
  it("propose_rule rejects an unknown account instead of matching the first account", async () => {
    await expect(
      read("propose_rule", {
        name: "x",
        conditions: [{ field: "account_is", value: "Conta Inexistente" }],
        actions: [{ type: "mark_reviewed" }],
      }),
    ).rejects.toThrow(/No account matching "Conta Inexistente"/);
  });

  it("create_transaction rejects an unknown account name", async () => {
    await expect(
      prepare("create_transaction", { description: "x", amount: 1, account: "Conta Inexistente" }),
    ).rejects.toThrow(/No account matching/);
  });
});

describe("propose_rule", () => {
  it("returns samples and how many matches are already in the target state", async () => {
    const out = await read("propose_rule", {
      name: "Giassi",
      conditions: [{ field: "description_contains", value: "giassi" }],
      actions: [{ type: "set_category", value: "Mercado" }],
    });
    expect(out.matchedCount).toBe(2);
    expect(out.alreadyInTargetCount).toBe(1);
    expect(out.wouldChangeCount).toBe(1);
    const byDescription = Object.fromEntries(out.sample.map((s: any) => [s.description, s]));
    expect(byDescription["GIASSI SUPERMERCADO"]).toMatchObject({ category: "Mercado", wouldChange: false });
    expect(byDescription["GIASSI LAR"]).toMatchObject({ category: "Casa", wouldChange: true, amountMinor: -2_000 });
  });

  it("accepts add_tag like create_rule", async () => {
    const out = await read("propose_rule", {
      name: "Tag giassi",
      conditions: [{ field: "description_contains", value: "giassi" }],
      actions: [{ type: "add_tag", value: "#viagem" }],
    });
    expect(out.then).toBe("add tag #viagem");
    expect(out.matchedCount).toBe(2);
    expect(out.alreadyInTargetCount).toBe(1);
  });
});

describe("get_spending_breakdown", () => {
  it("folds the tail into an Other row so the rows add up to the total", async () => {
    const out = await read("get_spending_breakdown", { limit: 2 });
    expect(out.totalMinor).toBe(20_000);
    expect(out.categoryCount).toBe(4);
    expect(out.truncated).toBe(true);
    expect(out.categories.map((c: any) => [c.name, c.spentMinor])).toEqual([
      ["Mercado", 10_000],
      ["Lazer", 5_000],
      ["Other (2 categories)", 5_000],
    ]);
    const full = await read("get_spending_breakdown", { limit: 100 });
    expect(full.truncated).toBe(false);
    expect(full.categories.reduce((s: number, c: any) => s + c.spentMinor, 0)).toBe(full.totalMinor);
  });

  it("takes an arbitrary month", async () => {
    const out = await read("get_spending_breakdown", { month: lastMonthDay });
    expect(out).toMatchObject({ totalMinor: 2_690, from: lastMonthDay, truncated: false });
  });
});

describe("get_transaction", () => {
  it("reports Open Finance as the source of a synced row", async () => {
    const out = await read("get_transaction", { id: ids.synced });
    expect(out).toMatchObject({ source: "Open Finance sync (pluggy)", sourceKind: "open_finance" });
    const manual = await read("get_transaction", { id: ids.cinema });
    expect(manual).toMatchObject({ source: "Manual entry", sourceKind: "manual" });
  });
});

describe("search_transactions", () => {
  it("filters uncategorised rows and sums every match, not just the page", async () => {
    const out = await read("search_transactions", { uncategorized: true, pageSize: 1 });
    expect(out.total).toBe(2);
    expect(out.transactions).toHaveLength(1);
    expect(out.totalSums).toEqual([{ currency: "BRL", sumMinor: -3_700, count: 2 }]);
    expect(out.pageSums).toHaveLength(1);
    expect(out.pageSums[0].count).toBe(1);
  });

  it("filters by tag name and by type/status for a spending total", async () => {
    const tagged = await read("search_transactions", { tag: "viagem" });
    expect(tagged.transactions.map((t: any) => t.description)).toEqual(["GIASSI LAR"]);
    const spend = await read("search_transactions", { type: "expense", status: "posted", from: monthRange(today).start });
    expect(spend.totalSums).toEqual([{ currency: "BRL", sumMinor: -20_000, count: 4 }]);
    await expect(read("search_transactions", { tag: "nope" })).rejects.toThrow(/No tag named/);
  });
});

describe("get_tags", () => {
  it("lists tags with how many transactions carry each", async () => {
    const out = await read("get_tags");
    expect(out.tags).toEqual([expect.objectContaining({ name: "viagem", transactionCount: 1 })]);
  });
});

describe("get_confidence", () => {
  it("does not call bills covered when the net liquid balance is negative", async () => {
    const out = await read("get_confidence");
    const obligations = out.factors.find((f: any) => f.key === "obligations");
    // -457 200 + 15 000 is below the 2 690 due; summing only positive balances read 15 000 as covered.
    expect(obligations).toMatchObject({ score: 55, note: "What's due exceeds your cash" });
  });
});

describe("bills", () => {
  it("offers only ledger-status transactions as payment candidates", async () => {
    const out = await read("get_bill_payment_candidates", { billId: ids.bill, limit: 100 });
    const candidateIds = out.candidates.map((c: any) => c.id);
    expect(candidateIds).not.toContain(ids.pending);
    expect(candidateIds).toContain(ids.utility);
  });

  it("refuses to link a pending transaction as the payment", async () => {
    await expect(prepare("mark_bill_paid", { id: ids.bill, transactionId: ids.pending })).rejects.toThrow(/pending/);
  });

  it("dates the payment at the linked transaction, not today", async () => {
    await write("mark_bill_paid", { id: ids.bill, transactionId: ids.utility });
    const bill = await db.query.bills.findFirst({ where: eq(bills.id, ids.bill) });
    expect(bill).toMatchObject({ lastPaidDate: lastMonthDay, lastPaidTransactionId: ids.utility });
    const listed = (await read("get_bills")).bills.find((b: any) => b.id === ids.bill);
    expect(listed.paidEvidence).toBe("transaction");
  });
});

describe("run_rule", () => {
  it("does not count matches already in the target state as applied", async () => {
    const created = await write("create_rule", {
      name: `Giassi ${stamp}`,
      conditions: [{ field: "description_contains", value: "giassi" }],
      actions: [
        { type: "set_category", value: "Mercado" },
        { type: "add_tag", value: "viagem" },
      ],
    });
    const ruleId = created.data.id as string;
    const first = await write("run_rule", { id: ruleId });
    expect(first.detail).toBe("2 matched, 2 changed, 0 already in the target state");
    // Everything now has the category and the tag: a re-run changes nothing.
    const second = await write("run_rule", { id: ruleId });
    expect(second.detail).toBe("2 matched, 0 changed, 2 already in the target state");
  });
});

describe("settings", () => {
  it("lets update_settings correct the country", async () => {
    expect(await read("get_settings")).toMatchObject({ country: "IN", currencyCode: "BRL", isDefault: false });
    const saved = await write("update_settings", { country: "br" });
    expect(saved.data).toMatchObject({ country: "BR", currency: "BRL" });
    expect(await read("get_settings")).toMatchObject({ country: "BR", isDefault: false });
  });
});
