import { z } from "zod";
import { withUser, ok, fail, parseBody } from "@/modules/shared/api";
import { env } from "@/lib/env";
import {
  archiveConversation,
  deleteConversation,
  getConversation,
  renameConversation,
} from "@/modules/agent/conversations";

export const GET = withUser(async (_req, { user, params }) => {
  if (!env().KOSH_AI_ENABLED) {
    return fail(404, "not_found", "AI is disabled.");
  }
  const thread = await getConversation(user.id, params.id!);
  if (!thread) return fail(404, "not_found", "Conversation not found.");
  return ok({
    messages: thread.messages.map((message) => ({
      role: message.role,
      text: message.text,
      blocks: message.blocks?.map((block) =>
        block.type === "proposal"
          ? { type: "warning" as const, text: "This older action proposal is no longer active. Kosh AI is read-only." }
          : block,
      ),
    })),
  });
});

const patchSchema = z.union([
  z.object({ action: z.literal("rename"), title: z.string().min(1).max(120) }),
  z.object({ action: z.literal("archive") }),
]);

export const PATCH = withUser(async (req, { user, params }) => {
  if (!env().KOSH_AI_ENABLED) {
    return fail(404, "not_found", "AI is disabled.");
  }
  const input = await parseBody(req, patchSchema);
  if (input.action === "rename") await renameConversation(user.id, params.id!, input.title);
  else await archiveConversation(user.id, params.id!);
  return ok({ updated: true });
});

export const DELETE = withUser(async (_req, { user, params }) => {
  if (!env().KOSH_AI_ENABLED) {
    return fail(404, "not_found", "AI is disabled.");
  }
  await deleteConversation(user.id, params.id!);
  return ok({ deleted: true });
});
