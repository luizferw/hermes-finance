import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  automationRules,
  categories,
  db,
  importFiles,
  openFinanceAccountLinks,
  openFinanceConnections,
  tags,
  transactions,
  userSettings,
  users,
} from "@kosh/db";
import type { ToolContext, WriteTool } from "../types";
import { ledgerWritesTools } from "./ledger-writes";

/**
 * Every ledger write tool, executed the way the MCP endpoint runs it:
 * parse → prepare → execute the prepared payload. Each test works on its own
 * user, removed (with everything it owns, by cascade) in afterAll.
 */
const stamp = randomUUID();
const userId = `ledger_writes_${stamp}`;
const ctx: ToolContext = {
  userId,
  currency: "BRL",
  scopes: ["finance:read", "transactions:write", "reviews:write", "rules:write", "automations:write", "settings:write"],
};

const tool = (name: string) => {
  const found = ledgerWritesTools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found as WriteTool;
};

async function run(name: string, args: Record<string, unknown>) {
  const t = tool(name);
  const prepared = await t.prepare(ctx, t.input.parse(args));
  const result = await t.execute(ctx, prepared.payload, randomUUID());
  return { prepared, result, data: (result as { data?: unknown }).data as Record<string, unknown> };
}

let bankId: string;
let walletId: string;

beforeAll(async () => {
  await db.insert(users).values({ id: userId, name: "Ledger writes probe", email: `${userId}@kosh.test` });
  const [bank] = await db
    .insert(accounts)
    .values({ userId, name: "Probe Bank", type: "asset", currencyCode: "BRL", openingBalanceMinor: 100_000, currentBalanceMinor: 100_000 })
    .returning();
  const [wallet] = await db
    .insert(accounts)
    .values({ userId, name: "Probe Wallet", type: "wallet", currencyCode: "BRL", openingBalanceMinor: 0, currentBalanceMinor: 0 })
    .returning();
  bankId = bank!.id;
  walletId = wallet!.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

async function balance(accountId: string) {
  const row = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return row!.currentBalanceMinor;
}

describe("categories and tags", () => {
  it("creates a category and a tag, and reports an existing one without writing", async () => {
    const cat = await run("create_category", { name: "Groceries" });
    expect(cat.data.created).toBe(true);
    const again = await run("create_category", { name: "Groceries" });
    expect(again.data).toMatchObject({ created: false, id: cat.data.id });

    const tag = await run("create_tag", { name: "trip" });
    expect(tag.data.created).toBe(true);
    const rows = await db.select().from(tags).where(eq(tags.userId, userId));
    expect(rows.map((r) => r.name)).toEqual(["trip"]);
  });
});

describe("transactions", () => {
  let txId: string;

  it("creates an expense with category, tags, notes and status", async () => {
    const { data } = await run("create_transaction", {
      description: "Market",
      amount: 12.5,
      account: "Probe Bank",
      category: "Groceries",
      tags: ["trip"],
      notes: "weekly",
      date: "2026-10-01",
    });
    txId = data.id as string;
    expect(data).toMatchObject({ amountMinor: -1250, currency: "BRL", status: "posted", type: "expense" });
    expect(await balance(bankId)).toBe(100_000 - 1250);
  });

  it("creates a transfer that nets to zero across both accounts", async () => {
    const { data } = await run("create_transaction", {
      description: "Top up",
      amount: 100,
      type: "transfer",
      account: "Probe Bank",
      toAccount: "Probe Wallet",
    });
    expect(data).toMatchObject({ type: "transfer", transferAccountId: walletId, amountMinor: -10_000 });
    expect(await balance(walletId)).toBe(10_000);
    expect(await balance(bankId)).toBe(100_000 - 1250 - 10_000);
  });

  it("refuses a category on a transfer", async () => {
    const t = tool("create_transaction");
    await expect(
      t.prepare(ctx, t.input.parse({ description: "x", amount: 1, type: "transfer", account: "Probe Bank", toAccount: "Probe Wallet", category: "Groceries" })),
    ).rejects.toThrow(/no category/);
  });

  it("updates fields and replaces tags", async () => {
    const { data } = await run("update_transaction", { id: txId, description: "Supermarket", notes: null, tags: [], merchant: "Pão" });
    expect(data.changed).toEqual(expect.arrayContaining(["description", "notes", "tagIds", "merchant"]));
    expect(data.tags).toEqual([]);
    const row = await db.query.transactions.findFirst({ where: eq(transactions.id, txId) });
    expect(row?.description).toBe("Supermarket");
    expect(row?.merchant).toBe("Pão");
  });

  it("rejects, restores and bulk-categorises by id", async () => {
    const rejected = await run("reject_transactions", { ids: [txId] });
    expect(rejected.data).toEqual({ rejected: 1 });
    expect(await balance(bankId)).toBe(100_000 - 10_000);

    const restored = await run("restore_transactions", { ids: [txId] });
    expect(restored.data).toEqual({ restored: 1 });
    const row = await db.query.transactions.findFirst({ where: eq(transactions.id, txId) });
    expect(row?.status).toBe("imported");

    await db.insert(categories).values({ userId, name: "Food" });
    const bulk = await run("bulk_categorise_transactions", { ids: [txId], category: "Food" });
    expect(bulk.data).toEqual({ updated: 1 });
  });

  it("soft-deletes a transaction and recomputes the balance", async () => {
    const { result } = await run("delete_transaction", { id: txId });
    expect(result.status).toBe("completed");
    const row = await db.query.transactions.findFirst({ where: eq(transactions.id, txId) });
    expect(row?.deletedAt).not.toBeNull();
    expect(await balance(bankId)).toBe(100_000 - 10_000);
  });
});

describe("rules", () => {
  let ruleId: string;

  it("creates a rule with description, runOnImport and add_tag", async () => {
    const { data, prepared } = await run("create_rule", {
      name: "Tag markets",
      description: "probe",
      runOnImport: false,
      conditions: [{ field: "amount_greater_than", value: "10" }],
      actions: [{ type: "add_tag", value: "trip" }],
    });
    ruleId = data.id as string;
    expect(prepared.fields.find((f) => f.label === "When")?.value).toContain("amount greater than");
    const row = await db.query.automationRules.findFirst({
      where: eq(automationRules.id, ruleId),
      with: { conditions: true, actions: true },
    });
    expect(row).toMatchObject({ description: "probe", runOnImport: false });
    expect(row?.conditions[0]?.value).toBe("1000");
    expect(row?.actions[0]?.type).toBe("add_tag");
  });

  it("updates and deletes the rule", async () => {
    await run("update_rule", {
      id: ruleId,
      name: "Renamed",
      conditions: [{ field: "account_is", value: "Probe Bank" }],
      actions: [{ type: "mark_reviewed" }],
    });
    const row = await db.query.automationRules.findFirst({
      where: eq(automationRules.id, ruleId),
      with: { conditions: true },
    });
    expect(row?.name).toBe("Renamed");
    expect(row?.conditions[0]?.value).toBe(bankId);

    await run("delete_rule", { id: ruleId });
    expect(await db.query.automationRules.findFirst({ where: eq(automationRules.id, ruleId) })).toBeUndefined();
  });
});

describe("accounts", () => {
  it("creates a credit card account and edits it without resetting other fields", async () => {
    const { data } = await run("create_account", {
      name: "Probe Card",
      type: "credit_card",
      limit: 5000,
      includeInNetWorth: false,
    });
    expect(data).toMatchObject({ currency: "BRL", limitMinor: 500_000, includeInNetWorth: false, openingBalanceMinor: 0 });

    const edited = await run("update_account", { account: "Probe Card", institution: "Nubank", archived: true });
    // includeInNetWorth stays false even though it was not passed.
    expect(edited.data).toMatchObject({ institution: "Nubank", isArchived: true, includeInNetWorth: false, limitMinor: 500_000 });

    const t = tool("update_account");
    await expect(t.prepare(ctx, t.input.parse({ account: "Probe Card", currency: "USD" }))).rejects.toThrow(/currency/);
  });
});

describe("imports", () => {
  const csv = [
    "Date,Description,Amount,Ref",
    "01/10/2026,Coffee,-8.50,A1",
    "02/10/2026,Salary,1000.00,A2",
    "02/10/2026,Salary,1000.00,A2",
    "bad,Broken,1,A3",
  ].join("\n");

  it("uploads, maps, commits, and refuses OFX", async () => {
    const t = tool("upload_import");
    await expect(
      t.prepare(ctx, t.input.parse({ account: "Probe Wallet", fileName: "x.ofx", csvText: "OFXHEADER:100\n<OFX>" })),
    ).rejects.toThrow(/OFX/);

    const up = await run("upload_import", { account: "Probe Wallet", fileName: "probe.csv", csvText: csv });
    expect(up.data).toMatchObject({ rowCount: 4, headers: ["Date", "Description", "Amount", "Ref"] });
    const importFileId = up.data.importFileId as string;

    const mapped = await run("apply_import_mapping", {
      importFileId,
      mapping: { date: "Date", description: "Description", amount: "Amount", externalId: "Ref" },
      dateFormat: "dd/MM/yyyy",
      saveAsTemplate: "Probe template",
    });
    expect(mapped.data.counts).toMatchObject({ total: 4, ready: 2, duplicates: 1, errors: 1 });
    const rows = mapped.data.rows as Array<{ id: string; status: string; amountMinor: number | null }>;
    expect(rows.find((r) => r.status === "pending")?.amountMinor).toBe(-850);
    const dupe = rows.find((r) => r.status === "duplicate")!;

    // The forced duplicate reuses external id A2, which is unique per account.
    const commit = tool("commit_import");
    await expect(
      commit.prepare(ctx, commit.input.parse({ importFileId, includeDuplicateRowIds: [dupe.id] })),
    ).rejects.toThrow(/external id "A2"/);

    const committed = await run("commit_import", { importFileId });
    expect(committed.data).toMatchObject({ created: 2 });
    const imported = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.importFileId, importFileId)));
    expect(imported.every((tx) => tx.status === "imported")).toBe(true);
  });

  it("imports a near-duplicate anyway when asked, and refuses an exact one", async () => {
    const again = ["Date,Description,Amount", "01/10/2026,Coffee,-8.50", "02/10/2026,Coffee shop,-8.50"].join("\n");
    const up = await run("upload_import", { account: "Probe Wallet", fileName: "again.csv", csvText: again });
    const importFileId = up.data.importFileId as string;
    const mapped = await run("apply_import_mapping", {
      importFileId,
      mapping: { date: "Date", description: "Description", amount: "Amount" },
    });
    expect(mapped.data.counts).toMatchObject({ ready: 0, duplicates: 2 });
    const rows = mapped.data.rows as Array<{ id: string; description: string; duplicateOf: { id: string | null } | null }>;
    const exact = rows.find((r) => r.description === "Coffee")!;
    const near = rows.find((r) => r.description === "Coffee shop")!;

    const commit = tool("commit_import");
    await expect(
      commit.prepare(ctx, commit.input.parse({ importFileId, includeDuplicateRowIds: [exact.id] })),
    ).rejects.toThrow(/same date, amount and description/);

    const committed = await run("commit_import", { importFileId, includeDuplicateRowIds: [near.id] });
    expect(committed.data).toMatchObject({ created: 1 });
    const [tx] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.importFileId, importFileId)));
    expect(tx?.description).toBe("Coffee shop");
    expect(tx?.suspectedDuplicateOfId).toBe(near.duplicateOf?.id);
  });

  it("re-applies a saved template and deletes an uncommitted import", async () => {
    const up = await run("upload_import", { account: "Probe Wallet", fileName: "second.csv", csvText: csv });
    const importFileId = up.data.importFileId as string;
    expect((up.data.templates as Array<{ name: string }>).map((t) => t.name)).toContain("Probe template");
    const mapped = await run("apply_import_mapping", { importFileId, template: "probe template", pageSize: 1 });
    expect((mapped.data.rows as unknown[]).length).toBe(1);
    expect(mapped.data.totalPages).toBe(4);

    await run("delete_import", { importFileId });
    expect(await db.query.importFiles.findFirst({ where: eq(importFiles.id, importFileId) })).toBeUndefined();
  });
});

describe("settings", () => {
  it("updates only the fields passed", async () => {
    const { data } = await run("update_settings", { locale: "pt-BR", dateFormat: "dd/MM/yyyy" });
    expect(data).toMatchObject({ locale: "pt-BR", dateFormat: "dd/MM/yyyy" });
    const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
    expect(row?.locale).toBe("pt-BR");
  });
});

describe("open finance", () => {
  it("registers, relinks, syncs (skipped when disabled) and removes a connection", async () => {
    const reg = await run("register_open_finance_connection", { itemId: randomUUID(), label: "Probe Pluggy" });
    const connectionId = reg.data.connectionId as string;
    expect(JSON.stringify(reg.result)).not.toMatch(/itemId/);

    const [link] = await db
      .insert(openFinanceAccountLinks)
      .values({
        userId,
        connectionId,
        providerAccountId: "prov-1",
        providerType: "BANK",
        providerName: "Conta",
        currencyCode: "BRL",
        linkMode: "auto_created",
        accountId: null,
      })
      .returning();
    const relinked = await run("update_open_finance_account_link", { linkId: link!.id, account: "Probe Bank" });
    expect(relinked.data).toMatchObject({ accountId: bankId, linkMode: "manual", isSyncEnabled: true });

    const sync = await run("sync_open_finance_now", { connectionId });
    expect(sync.data).toMatchObject({ status: "skipped", connectionId });

    await run("remove_open_finance_connection", { connectionId });
    expect(
      await db.query.openFinanceConnections.findFirst({ where: eq(openFinanceConnections.id, connectionId) }),
    ).toBeUndefined();
  });
});
