import "server-only";
import { z } from "zod";
import { TOOL_BY_NAME } from "./registry";
import { verifyProposal, signProposal, newIdempotencyKey } from "./confirm";
import { claimAction, finishAction } from "./recorder";
import type { ActionProposal, ExecStatus, ResponseBlock, ToolContext, WriteTool } from "./types";

/**
 * Resolve model/edited args into a frozen, signed confirmation proposal. Shared
 * by the agent loop and the edit/re-prepare route so signing only ever happens
 * server-side and the two paths can't diverge.
 */
export async function prepareProposal(
  ctx: ToolContext,
  tool: WriteTool,
  args: Record<string, unknown>,
): Promise<ActionProposal> {
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const prepared = await tool.prepare(ctx, parsed);
  const idempotencyKey = newIdempotencyKey();
  return {
    toolName: tool.name,
    risk: tool.risk,
    title: prepared.title,
    summary: prepared.summary,
    fields: prepared.fields,
    affectedCount: prepared.affectedCount,
    warning: prepared.warning,
    undoable: prepared.undoable,
    payload: prepared.payload,
    idempotencyKey,
    editable: parsed,
    signature: signProposal({
      toolName: tool.name,
      payload: prepared.payload,
      userId: ctx.userId,
      idempotencyKey,
    }),
  };
}

export const confirmSchema = z.object({
  toolName: z.string(),
  payload: z.unknown(),
  idempotencyKey: z.string().min(1),
  signature: z.string().min(1),
});
export type ConfirmInput = z.infer<typeof confirmSchema>;

export interface ExecOutcome {
  status: ExecStatus;
  title: string;
  detail?: string;
  block?: ResponseBlock;
}

/**
 * Execute a previously-frozen write proposal. The signature must verify against
 * THIS user — a tampered payload, a swapped tool, or a stolen-but-mismatched
 * key all fail. Idempotent: a retry with the same key never mutates twice.
 */
export async function executeProposal(
  ctx: ToolContext,
  input: ConfirmInput,
  source: "session" | "mcp",
): Promise<ExecOutcome> {
  const tool = TOOL_BY_NAME.get(input.toolName);
  if (!tool || tool.kind !== "write") {
    return { status: "validation_failed", title: "Unknown action." };
  }
  if (!ctx.scopes.includes(tool.requiredScope)) {
    return { status: "permission_denied", title: "Not permitted." };
  }

  const valid = verifyProposal(
    {
      toolName: input.toolName,
      payload: input.payload,
      userId: ctx.userId,
      idempotencyKey: input.idempotencyKey,
    },
    input.signature,
  );
  if (!valid) {
    return { status: "permission_denied", title: "This action could not be verified." };
  }

  const claim = await claimAction({
    userId: ctx.userId,
    idempotencyKey: input.idempotencyKey,
    toolName: input.toolName,
    source,
  });
  if (!claim.firstTime) {
    if (claim.priorStatus !== "completed") {
      return {
        status:
          claim.priorStatus === "pending"
            ? "temporary_failure"
            : claim.priorStatus ?? "temporary_failure",
        title:
          claim.priorStatus === "pending"
            ? "Already in progress."
            : "Already attempted.",
        detail:
          claim.priorStatus === "pending"
            ? "Check the activity log before trying again."
            : "The earlier attempt did not complete. Prepare a new action to retry.",
      };
    }
    return {
      status: "already_completed",
      title: "Already done.",
      detail: "This action was already applied.",
    };
  }

  try {
    const result = await tool.execute(ctx, input.payload, input.idempotencyKey);
    await finishAction({
      idempotencyKey: input.idempotencyKey,
      status: result.status,
      summary: { title: result.title, detail: result.detail },
    });
    return result;
  } catch (err) {
    const status: ExecStatus = "validation_failed";
    await finishAction({
      idempotencyKey: input.idempotencyKey,
      status,
      error: err instanceof Error ? err.name : "execution_failed",
    });
    return {
      status,
      title: "Couldn't apply that.",
      detail: "The action failed validation or could not be completed.",
    };
  }
}
