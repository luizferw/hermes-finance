import { z } from "zod";
import { withUser, parseBody, fail } from "@/modules/shared/api";
import { env } from "@/lib/env";
import { getUserSettings } from "@/modules/settings/queries";
import { runAgentTurn, AiUnavailableError } from "@/modules/agent/agent";
import type { AgentContent } from "@/modules/agent/provider";
import { MCP_READ_SCOPES, type ResponseBlock, type ToolContext } from "@/modules/agent/types";
import { answerAsk } from "@/modules/ask/orchestrate";
import type { AskAnswer } from "@/modules/ask/answer";
import {
  appendAssistantMessage,
  appendUserMessage,
  autoTitle,
  getConversation,
} from "@/modules/agent/conversations";

const chatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  /** When set, the turn is persisted to this conversation. */
  conversationId: z.string().uuid().optional(),
});

export const POST = withUser(async (req, { user }) => {
  if (!env().KOSH_AI_ENABLED) {
    return fail(404, "not_found", "AI is disabled.");
  }
  const { message, conversationId } = await parseBody(req, chatSchema);
  const currency = (await getUserSettings(user.id)).currencyCode;
  const ctx: ToolContext = { userId: user.id, scopes: [...MCP_READ_SCOPES], currency };

  // Model history is loaded from the owned server-side conversation. Never
  // accept model/tool turns from the browser: fabricated tool results would
  // make financial answers look authoritative without querying the ledger.
  let convId: string | undefined;
  let history: AgentContent[] = [];
  if (conversationId) {
    const existing = await getConversation(user.id, conversationId);
    if (!existing) return fail(404, "not_found", "Conversation not found.");
    convId = conversationId;
    const recent = existing.modelContents.slice(-40);
    const firstUser = recent.findIndex((content) => content.role === "user");
    history = firstUser >= 0 ? recent.slice(firstUser) : [];
    if (existing.messages.length === 0) await autoTitle(user.id, convId, message);
    await appendUserMessage(user.id, convId, message);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };

      void (async () => {
        try {
          const result = await runAgentTurn(ctx, {
            message,
            history,
            onEvent: (event) => send({ type: "progress", event }),
          });
          if (convId) {
            await appendAssistantMessage(user.id, convId, result.blocks, result.history);
          }
          send({
            type: "result",
            data: { blocks: result.blocks, events: result.events, aiEnabled: true },
          });
        } catch (err) {
          if (err instanceof AiUnavailableError) {
            const answer = await answerAsk(message);
            const blocks = askAnswerToBlocks(answer);
            const modelHistory: AgentContent[] = [...history, { role: "user", text: message }];
            if (convId) {
              await appendAssistantMessage(user.id, convId, blocks, modelHistory);
            }
            send({ type: "result", data: { blocks, events: [], aiEnabled: false } });
          } else {
            console.error("Agent turn failed:", err instanceof Error ? err.name : "unknown");
            const text = "Kosh couldn't finish that response. Please try again.";
            if (convId) {
              await appendAssistantMessage(
                user.id,
                convId,
                [{ type: "warning", text }],
                [...history, { role: "user", text: message }],
              );
            }
            send({ type: "error", message: text });
          }
        } finally {
          if (open) controller.close();
          open = false;
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
});

/** Render a deterministic AskAnswer through the same block UI as the agent. */
function askAnswerToBlocks(a: AskAnswer): ResponseBlock[] {
  switch (a.kind) {
    case "amount":
      return [
        {
          type: "figure",
          title: a.title,
          figure: { label: a.title, amountMinor: a.amountMinor, currency: a.currency },
          caption: a.caption,
        },
      ];
    case "categories":
      return [
        { type: "breakdown", title: a.title, currency: a.currency, rows: a.rows, totalMinor: a.totalMinor },
      ];
    case "transactions":
      return [
        {
          type: "transactions",
          title: a.title,
          rows: a.txns.map((t) => ({
            id: t.id,
            date: t.date,
            description: t.description,
            amountMinor: t.amountMinor,
            currency: t.currencyCode,
            category: t.category?.name ?? null,
          })),
          moreCount: a.moreCount,
          href: a.href,
        },
      ];
    case "bills":
      return [
        {
          type: "commitments",
          title: a.title,
          currency: a.currency,
          rows: a.rows.map((b) => ({
            id: b.id,
            name: b.name,
            amountMinor: b.amountMinor,
            currency: b.currencyCode,
            dueDate: b.dueDate,
            daysUntilDue: b.daysUntilDue,
            overdue: b.overdue,
          })),
        },
      ];
    case "compare":
      return [{ type: "comparison", title: a.title, currency: a.currency, a: a.a, b: a.b }];
    case "navigate":
      return [{ type: "text", text: `Open ${a.label} from the menu to see that.` }];
    case "none":
      return [
        {
          type: "text",
          text: "AI is turned off, so I can only answer set questions. Try “where did my money go”, “what's due soon”, or search your transactions.",
        },
      ];
    default:
      return [{ type: "text", text: "No answer." }];
  }
}
