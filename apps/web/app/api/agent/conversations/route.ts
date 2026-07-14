import { z } from "zod";
import { withUser, ok, parseBody, fail } from "@/modules/shared/api";
import { env } from "@/lib/env";
import { createConversation, listConversations } from "@/modules/agent/conversations";

export const GET = withUser(async (_req, { user }) => {
  if (!env().KOSH_AI_ENABLED) {
    return fail(404, "not_found", "AI is disabled.");
  }
  return ok({ conversations: await listConversations(user.id) });
});

const createSchema = z.object({ title: z.string().max(120).optional() });

export const POST = withUser(async (req, { user }) => {
  if (!env().KOSH_AI_ENABLED) {
    return fail(404, "not_found", "AI is disabled.");
  }
  const { title } = await parseBody(req, createSchema);
  return ok({ conversation: await createConversation(user.id, title) });
});
