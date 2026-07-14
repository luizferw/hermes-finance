import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, users, savingsGoals, automationRules, aiConversations } from "@kosh/db";
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

describe("read tool isolation", () => {
  it("exposes no write tools through MCP", () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
    expect(MCP_TOOLS.every((tool) => tool.kind === "read")).toBe(true);
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

  it("does not grant legacy write scopes", async () => {
    await expect(
      createMcpToken(userId, "VITEST read-only", ["transactions:write"]),
    ).rejects.toThrow("At least one read scope is required.");
  });
});
