import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  db,
  users,
  accounts,
  savingsGoals,
  automationRules,
  aiConversations,
  purchaseItems,
  purchasePlans,
} from "@kosh/db";
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversation,
  getConversation,
} from "./conversations";
import { claimAction } from "./recorder";
import { prepareProposal } from "./execute";
import { executeProposal } from "./execute";
import { MCP_TOOLS, TOOL_BY_NAME } from "./registry";
import { getSafeToSpend } from "@/modules/finance/queries";
import { todayIso } from "@kosh/domain";
import { createPurchaseItemCore, createPurchasePlanCore } from "@/modules/finance/mutations";
import { listAccounts } from "@/modules/accounts/queries";
import {
  createMcpToken,
  verifyMcpToken,
  revokeMcpToken,
} from "./mcp-tokens";
import { newIdempotencyKey, signProposal } from "./confirm";
import type { ReadTool, Scope, ToolContext, WriteTool } from "./types";

const ALL: Scope[] = ["finance:read", "transactions:write", "plans:write", "goals:write", "reviews:write", "rules:read", "rules:write", "automations:read", "automations:write"];

let userId: string;
let ctx: ToolContext;

beforeAll(async () => {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, "demo@kosh.local")).limit(1);
  if (!u) throw new Error("seed demo user missing — run pnpm db:seed");
  userId = u.id;
  ctx = { userId, scopes: ALL, currency: "INR" };
});

afterAll(async () => {
  await db.delete(savingsGoals).where(like(savingsGoals.name, "VITEST_%"));
  await db.delete(automationRules).where(like(automationRules.name, "VITEST_%"));
  await db.delete(aiConversations).where(like(aiConversations.title, "VITEST%"));
  await db.delete(purchasePlans).where(like(purchasePlans.name, "VITEST_%"));
});

describe("idempotency gate", () => {
  it("claims a key once; a retry sees the prior outcome", async () => {
    const key = newIdempotencyKey();
    const first = await claimAction({ userId, idempotencyKey: key, toolName: "t", source: "session" });
    const second = await claimAction({ userId, idempotencyKey: key, toolName: "t", source: "session" });
    expect(first.firstTime).toBe(true);
    expect(second.firstTime).toBe(false);
  });
});

describe("MCP tool exposure", () => {
  it("exposes read and write tools through MCP", () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
    expect(MCP_TOOLS.some((tool) => tool.kind === "read")).toBe(true);
    expect(MCP_TOOLS.some((tool) => tool.kind === "write")).toBe(true);
  });

  it("returns the demo user's accounts and nothing for a stranger", async () => {
    const tool = TOOL_BY_NAME.get("get_accounts") as ReadTool;
    const mine = (await tool.execute(ctx, {})).forModel as { accounts: unknown[] };
    expect(mine.accounts.length).toBeGreaterThan(0);
    const stranger = (await tool.execute({ ...ctx, userId: "00000000-0000-0000-0000-000000000000" }, {}))
      .forModel as { accounts: unknown[] };
    expect(stranger.accounts.length).toBe(0);
  });

  it("returns bounded structured finance cards from owned data", async () => {
    const expected = new Map([
      ["get_safe_to_spend", "safeToSpend"],
      ["get_cash_flow", "cashflow"],
      ["get_budgets", "budgets"],
      ["get_goals", "goals"],
      ["get_recurring_transactions", "recurring"],
      ["find_unusual_spending", "anomalies"],
      ["list_missing_setup_items", "missingData"],
    ]);
    for (const [name, blockType] of expected) {
      const tool = TOOL_BY_NAME.get(name) as ReadTool;
      const input = tool.input.parse({});
      const result = await tool.execute(ctx, input);
      expect(result.block?.type, name).toBe(blockType);
      expect(JSON.stringify(result.forModel).length, name).toBeLessThan(50_000);
    }
  });

  it("runs the P0 finance-domain read tools against the demo user's own data", async () => {
    const noArgTools = [
      "get_position",
      "get_projection",
      "get_projected_commitments",
      "get_credit_cards",
      "get_confidence_breakdown",
      "get_purchase_plans",
    ];
    for (const name of noArgTools) {
      const tool = TOOL_BY_NAME.get(name) as ReadTool;
      const input = tool.input.parse({});
      const result = await tool.execute(ctx, input);
      expect(result.forModel, name).toBeDefined();
      expect(JSON.stringify(result.forModel).length, name).toBeLessThan(50_000);
    }

    // Unknown ids resolve to a not_found payload rather than leaking another
    // user's row or throwing.
    const statementTool = TOOL_BY_NAME.get("get_card_statement") as ReadTool;
    const statement = (await statementTool.execute(ctx, {
      cardId: "00000000-0000-0000-0000-000000000000",
    })) as { forModel: { error?: string } };
    expect(statement.forModel.error).toBe("not_found");

    const planTool = TOOL_BY_NAME.get("get_purchase_plan") as ReadTool;
    const plan = (await planTool.execute(ctx, { id: "00000000-0000-0000-0000-000000000000" })) as {
      forModel: { error?: string };
    };
    expect(plan.forModel.error).toBe("not_found");
  });

  it("reports the reserve and staleness the engine actually computed, not a re-derived guess", async () => {
    const direct = await getSafeToSpend(userId, 30);
    const tool = TOOL_BY_NAME.get("get_safe_to_spend") as ReadTool;
    const result = (await tool.execute(ctx, tool.input.parse({ horizonDays: 30 }))).forModel as {
      hardReserveMinor: number;
      staleAccountNames: string[];
    };

    // hardReserveMinor used to be derived as (minimumBalance - safeToSpend),
    // which breaks the moment safeToSpend is clamped to 0 by the reserve
    // itself — the exact case that made this worth asserting directly.
    expect(result.hardReserveMinor).toBe(direct.hardReserveMinor);
    expect(result.staleAccountNames).toEqual(direct.staleAccountNames);
  });

  it("simulate_purchase and compare_payment_options never fabricate a recommendation", async () => {
    const simulate = TOOL_BY_NAME.get("simulate_purchase") as ReadTool;
    const option = { id: "sim1", method: "pix" as const, amountMinor: 5_000 };
    const simResult = (await simulate.execute(ctx, simulate.input.parse({ option }))).forModel as {
      feasible: boolean;
      rejections: unknown[];
      reasons: string[];
    };
    expect(typeof simResult.feasible).toBe("boolean");
    expect(Array.isArray(simResult.rejections)).toBe(true);
    expect(simResult.reasons.length).toBeGreaterThan(0);
    // PIX today: the first settlement is today.
    expect((simResult as unknown as { firstSettlementDate: string }).firstSettlementDate).toBe(todayIso());

    const compare = TOOL_BY_NAME.get("compare_payment_options") as ReadTool;
    const compareResult = (
      await compare.execute(
        ctx,
        compare.input.parse({ options: [option, { id: "sim2", method: "cash" as const, amountMinor: 5_000 }] }),
      )
    ).forModel as { status: string; blockers: string[]; recommendedOptionId?: string; options: unknown[] };
    expect(["OK", "NO_FEASIBLE_OPTION", "INSUFFICIENT_DATA"]).toContain(compareResult.status);
    expect(Array.isArray(compareResult.blockers)).toBe(true);
    expect(compareResult.options.length).toBe(2);
    // Never a fabricated recommendation when the engine found none feasible —
    // but always a ranking, so the least bad is visible.
    const ranked = compareResult as unknown as {
      ranking: Array<{ optionId: string; decidedBy: string | null }>;
      leastBadOptionId?: string;
    };
    expect(ranked.ranking).toHaveLength(2);
    expect(ranked.ranking[0]!.decidedBy).toBeNull();
    expect(ranked.ranking[1]!.decidedBy).not.toBeNull();
    if (compareResult.status !== "OK") {
      expect(compareResult.recommendedOptionId).toBeUndefined();
      expect(ranked.leastBadOptionId).toBe(ranked.ranking[0]!.optionId);
    } else {
      expect(compareResult.recommendedOptionId).toBe(ranked.ranking[0]!.optionId);
    }
  });
});

describe("write execution via confirmation", () => {
  const tool = () => TOOL_BY_NAME.get("create_goal") as WriteTool;

  it("executes a confirmed proposal, and is idempotent on retry", async () => {
    const proposal = await prepareProposal(ctx, tool(), {
      name: `VITEST_${Date.now()}`,
      targetAmount: 200000,
    });
    const input = {
      toolName: proposal.toolName,
      payload: proposal.payload,
      idempotencyKey: proposal.idempotencyKey,
      signature: proposal.signature,
    };
    const first = await executeProposal(ctx, input, "session");
    expect(first.status).toBe("completed");

    // Same frozen payload + key again → no second goal created.
    const before = await db.select().from(savingsGoals).where(like(savingsGoals.name, "VITEST_%"));
    const second = await executeProposal(ctx, input, "session");
    expect(second.status).toBe("already_completed");
    const after = await db.select().from(savingsGoals).where(like(savingsGoals.name, "VITEST_%"));
    expect(after.length).toBe(before.length);
  });

  it("rejects a tampered signature", async () => {
    const proposal = await prepareProposal(ctx, tool(), { name: "VITEST_x", targetAmount: 1000 });
    const r = await executeProposal(
      ctx,
      { toolName: proposal.toolName, payload: proposal.payload, idempotencyKey: proposal.idempotencyKey, signature: "deadbeef" },
      "session",
    );
    expect(r.status).toBe("permission_denied");
  });

  it("rejects a payload signed for a different user", async () => {
    const proposal = await prepareProposal(ctx, tool(), { name: "VITEST_y", targetAmount: 1000 });
    const otherCtx: ToolContext = { ...ctx, userId: "someone-else" };
    const r = await executeProposal(
      otherCtx,
      { toolName: proposal.toolName, payload: proposal.payload, idempotencyKey: proposal.idempotencyKey, signature: proposal.signature },
      "session",
    );
    expect(r.status).toBe("permission_denied");
  });

  it("does not report a failed action as already completed on retry", async () => {
    const idempotencyKey = newIdempotencyKey();
    const payload = { name: "VITEST_invalid", targetAmount: -1, currentAmount: 0 };
    const input = {
      toolName: "create_goal",
      payload,
      idempotencyKey,
      signature: signProposal({ toolName: "create_goal", payload, userId, idempotencyKey }),
    };
    expect((await executeProposal(ctx, input, "session")).status).toBe("validation_failed");
    const retry = await executeProposal(ctx, input, "session");
    expect(retry.status).toBe("validation_failed");
    expect(retry.title).toBe("Already attempted.");
  });
});

describe("rule tools", () => {
  it("propose_rule dry-runs without saving", async () => {
    const before = await db.select().from(automationRules).where(eq(automationRules.userId, userId));
    const tool = TOOL_BY_NAME.get("propose_rule") as ReadTool;
    const res = await tool.execute(ctx, {
      name: "VITEST_dryrun",
      matchAll: true,
      conditions: [{ field: "description_contains", value: "a" }],
      actions: [{ type: "rename_merchant", value: "Clean Name" }],
    });
    expect(res.block?.type).toBe("ruleDraft");
    const fm = res.forModel as { matchedCount: number; note: string };
    expect(typeof fm.matchedCount).toBe("number");
    // Nothing was persisted.
    const after = await db.select().from(automationRules).where(eq(automationRules.userId, userId));
    expect(after.length).toBe(before.length);
  });

  it("create_rule persists only after a confirmed proposal", async () => {
    const tool = TOOL_BY_NAME.get("create_rule") as WriteTool;
    const proposal = await prepareProposal(ctx, tool, {
      name: `VITEST_${Date.now()}`,
      matchAll: true,
      conditions: [{ field: "description_contains", value: "zzz-no-match-zzz" }],
      actions: [{ type: "mark_reviewed" }],
    });
    expect(proposal.risk).toBe("sensitive"); // rule creation always confirms
    const r = await executeProposal(
      ctx,
      { toolName: proposal.toolName, payload: proposal.payload, idempotencyKey: proposal.idempotencyKey, signature: proposal.signature },
      "session",
    );
    expect(r.status).toBe("completed");
    const saved = await db.select().from(automationRules).where(like(automationRules.name, "VITEST_%"));
    expect(saved.length).toBeGreaterThan(0);
  });

  it("denies a rule write when rules:write scope is absent (external client safety)", async () => {
    const tool = TOOL_BY_NAME.get("create_rule") as WriteTool;
    const proposal = await prepareProposal(ctx, tool, {
      name: "VITEST_scope",
      matchAll: true,
      conditions: [{ field: "description_contains", value: "x" }],
      actions: [{ type: "mark_reviewed" }],
    });
    const readOnly: ToolContext = { ...ctx, scopes: ["finance:read", "rules:read"] };
    const r = await executeProposal(
      readOnly,
      { toolName: proposal.toolName, payload: proposal.payload, idempotencyKey: proposal.idempotencyKey, signature: proposal.signature },
      "mcp",
    );
    expect(r.status).toBe("permission_denied");
  });
});

describe("conversation persistence", () => {
  it("stores and resumes a thread with rendered blocks + model history", async () => {
    const conv = await createConversation(userId, "VITEST chat");
    await appendUserMessage(userId, conv.id, "where did my money go");
    await appendAssistantMessage(
      userId,
      conv.id,
      [{ type: "text", text: "Here is your spending." }],
      [{ role: "user", text: "where did my money go" }, { role: "model", text: "Here is your spending." }],
    );
    const thread = await getConversation(userId, conv.id);
    expect(thread?.messages.length).toBe(2);
    expect(thread?.messages[1]?.blocks?.[0]).toMatchObject({ type: "text" });
    expect(thread?.modelContents.length).toBe(2);

    // a stranger cannot read it
    const stranger = await getConversation("00000000-0000-0000-0000-000000000000", conv.id);
    expect(stranger).toBeNull();
  });
});

describe("mcp scoped tokens", () => {
  it("creates, verifies scopes, then revokes", async () => {
    const { token } = await createMcpToken(userId, "VITEST token", ["finance:read"]);
    expect(token.startsWith("kosh_mcp_")).toBe(true);
    const resolved = await verifyMcpToken(token);
    expect(resolved?.userId).toBe(userId);
    expect(resolved?.scopes).toEqual(["finance:read"]);

    // a forged/unknown token resolves to null
    expect(await verifyMcpToken("kosh_mcp_forged")).toBeNull();

    const list = await import("./mcp-tokens").then((m) => m.listMcpTokens(userId));
    const created = list.find((t) => t.name === "VITEST token");
    await revokeMcpToken(userId, created!.id);
    expect(await verifyMcpToken(token)).toBeNull();
  });

  it("grants configured write scopes", async () => {
    const { token } = await createMcpToken(userId, "VITEST write", ["rules:write"]);
    expect((await verifyMcpToken(token))?.scopes).toEqual(["rules:write"]);
  });
});

/* ── purchase plan write tools, driven the way /api/mcp drives them:
   parse → prepare → execute the prepared payload, no confirmation step ─── */

async function runLikeMcp(name: string, args: Record<string, unknown>, as: ToolContext = ctx) {
  const tool = TOOL_BY_NAME.get(name) as WriteTool;
  const input = tool.input.parse(args);
  const prepared = await tool.prepare(as, input);
  return { prepared, result: await tool.execute(as, prepared.payload, newIdempotencyKey()) };
}

function idFrom(detail: string | undefined) {
  const id = /id ([0-9a-f-]{36})/.exec(detail ?? "")?.[1];
  if (!id) throw new Error(`no id in "${detail}"`);
  return id;
}

describe("purchase plan write tools", () => {
  it("creates, edits, sets aside and deletes a plan and its item", async () => {
    const account = (await listAccounts(userId)).find((a) => !a.isArchived)!;

    const created = await runLikeMcp("create_purchase_plan", {
      name: `VITEST_plan_${Date.now()}`,
      budget: 1000.5,
      targetDate: "2026-12-01",
    });
    expect(created.result.status).toBe("completed");
    expect(created.prepared.fields.find((f) => f.label === "Budget")?.value).toBeTruthy();
    const planId = idFrom(created.result.detail);
    let plan = await db.query.purchasePlans.findFirst({ where: eq(purchasePlans.id, planId) });
    expect(plan).toMatchObject({ userId, currencyCode: "INR", budgetMinor: 100050, targetDate: "2026-12-01" });

    const added = await runLikeMcp("create_purchase_item", {
      planId,
      name: "Crib",
      amount: 899.9,
      account: account.name,
      installments: 3,
    });
    expect(added.result.status).toBe("completed");
    const itemId = idFrom(added.result.detail);
    let item = await db.query.purchaseItems.findFirst({ where: eq(purchaseItems.id, itemId) });
    expect(item).toMatchObject({
      purchasePlanId: planId,
      estimatedPriceMinor: 89990,
      accountId: account.id,
      installments: 3,
      isActive: true,
    });

    await expect(
      runLikeMcp("create_purchase_item", { planId, name: "Typo", amount: 1, account: "VITEST_no_such_account" }),
    ).rejects.toThrow(/No account matching/);

    const edited = await runLikeMcp("update_purchase_item", {
      id: itemId,
      amount: 950,
      purchaseDate: "2026-11-20",
      account: null,
    });
    expect(edited.result.status).toBe("completed");
    item = await db.query.purchaseItems.findFirst({ where: eq(purchaseItems.id, itemId) });
    expect(item).toMatchObject({ name: "Crib", estimatedPriceMinor: 95000, purchaseDate: "2026-11-20", accountId: null });

    await expect(runLikeMcp("update_purchase_item", { id: itemId })).rejects.toThrow(/Nothing to change/);

    await runLikeMcp("set_purchase_item_active", { id: itemId, isActive: false });
    item = await db.query.purchaseItems.findFirst({ where: eq(purchaseItems.id, itemId) });
    expect(item?.isActive).toBe(false);

    await runLikeMcp("update_purchase_plan", { id: planId, status: "archived", budget: null });
    plan = await db.query.purchasePlans.findFirst({ where: eq(purchasePlans.id, planId) });
    expect(plan).toMatchObject({ status: "archived", budgetMinor: null, targetDate: "2026-12-01" });

    const removedItem = await runLikeMcp("delete_purchase_item", { id: itemId });
    expect(removedItem.prepared.undoable).toBe(false);
    expect(await db.query.purchaseItems.findFirst({ where: eq(purchaseItems.id, itemId) })).toBeUndefined();

    const removedPlan = await runLikeMcp("delete_purchase_plan", { id: planId });
    expect(removedPlan.result.status).toBe("completed");
    expect(await db.query.purchasePlans.findFirst({ where: eq(purchasePlans.id, planId) })).toBeUndefined();
  });

  it("refuses another user's plan, item and account with a 404", async () => {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "prd-scenario@kosh.local"))
      .limit(1);
    if (!other) throw new Error("prd scenario user missing — run seed:prd-scenario");
    const foreignPlan = await createPurchasePlanCore(other.id, { name: `VITEST_foreign_${Date.now()}`, currencyCode: "BRL", status: "active" });
    const foreignItem = await createPurchaseItemCore(other.id, {
      purchasePlanId: foreignPlan.id,
      name: "Stroller",
      amount: 2500,
      installments: 1,
    });
    const [foreignAccount] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, other.id)).limit(1);

    // The read used by prepare is owner-scoped, so a foreign id never gets a proposal.
    for (const [name, args] of [
      ["update_purchase_plan", { id: foreignPlan.id, name: "pwned" }],
      ["delete_purchase_plan", { id: foreignPlan.id }],
      ["create_purchase_item", { planId: foreignPlan.id, name: "x", amount: 1 }],
      ["update_purchase_item", { id: foreignItem.id, name: "pwned" }],
      ["set_purchase_item_active", { id: foreignItem.id, isActive: false }],
      ["delete_purchase_item", { id: foreignItem.id }],
    ] as const) {
      await expect(runLikeMcp(name, args), name).rejects.toThrow(/not found/);
    }

    // A forged payload that skips prepare still hits the xCore ownership asserts.
    const exec = (name: string, payload: unknown) =>
      (TOOL_BY_NAME.get(name) as WriteTool).execute(ctx, payload, newIdempotencyKey());
    await expect(exec("delete_purchase_plan", { id: foreignPlan.id })).rejects.toMatchObject({ status: 404 });
    await expect(exec("update_purchase_plan", { id: foreignPlan.id, changes: { name: "pwned" } })).rejects.toMatchObject({ status: 404 });
    await expect(
      exec("create_purchase_item", { purchasePlanId: foreignPlan.id, name: "x", amount: 1, installments: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(exec("delete_purchase_item", { id: foreignItem.id })).rejects.toMatchObject({ status: 404 });
    await expect(exec("set_purchase_item_active", { id: foreignItem.id, isActive: false })).rejects.toMatchObject({ status: 404 });

    const ownPlan = await createPurchasePlanCore(userId, { name: `VITEST_own_${Date.now()}`, currencyCode: "INR", status: "active" });
    await expect(
      exec("create_purchase_item", { purchasePlanId: ownPlan.id, name: "x", amount: 1, accountId: foreignAccount!.id, installments: 1 }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await db.query.purchasePlans.findFirst({ where: eq(purchasePlans.id, foreignPlan.id) })).toMatchObject({
      name: foreignPlan.name,
    });
    expect(await db.query.purchaseItems.findFirst({ where: eq(purchaseItems.id, foreignItem.id) })).toMatchObject({
      name: "Stroller",
      isActive: true,
    });
  });
});
