import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { aiConversations, aiMessages, db } from "@kosh/db";
import type { AgentContent } from "./provider";
import type { ResponseBlock } from "./types";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  text: string | null;
  blocks: ResponseBlock[] | null;
}

/** A conversation summary for the history panel. */
export async function listConversations(userId: string) {
  return db
    .select({
      id: aiConversations.id,
      title: aiConversations.title,
      pinned: aiConversations.pinned,
      updatedAt: aiConversations.updatedAt,
    })
    .from(aiConversations)
    .where(and(eq(aiConversations.userId, userId), isNull(aiConversations.archivedAt)))
    .orderBy(desc(aiConversations.pinned), desc(aiConversations.updatedAt))
    .limit(50);
}

export async function createConversation(userId: string, title?: string) {
  const [c] = await db
    .insert(aiConversations)
    .values({ userId, title: title?.slice(0, 120) || "New conversation" })
    .returning();
  return c!;
}

/** Full thread for replay/reopen. Verifies ownership. */
export async function getConversation(userId: string, id: string) {
  const conv = await db.query.aiConversations.findFirst({
    where: and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)),
  });
  if (!conv) return null;
  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, id))
    .orderBy(aiMessages.createdAt);
  const messages: StoredMessage[] = rows.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    text: m.text,
    blocks: (m.blocks as ResponseBlock[] | null) ?? null,
  }));
  // The model history to replay is the last assistant turn's stored contents.
  const lastModel = [...rows].reverse().find((m) => m.modelContents);
  const modelContents = (lastModel?.modelContents as AgentContent[] | null) ?? [];
  return { conversation: conv, messages, modelContents };
}

export async function appendUserMessage(userId: string, conversationId: string, text: string) {
  await db.insert(aiMessages).values({ conversationId, userId, role: "user", text });
  await touch(conversationId);
}

export async function appendAssistantMessage(
  userId: string,
  conversationId: string,
  blocks: ResponseBlock[],
  modelContents: AgentContent[],
) {
  await db
    .insert(aiMessages)
    .values({ conversationId, userId, role: "assistant", blocks, modelContents });
  await touch(conversationId);
}

async function touch(conversationId: string) {
  await db
    .update(aiConversations)
    .set({ updatedAt: new Date() })
    .where(eq(aiConversations.id, conversationId));
}

/** First few words of the opening question make a serviceable title. */
export async function autoTitle(userId: string, conversationId: string, firstMessage: string) {
  const title = firstMessage.trim().replace(/\s+/g, " ").slice(0, 60) || "New conversation";
  await db
    .update(aiConversations)
    .set({ title })
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)));
}

export async function renameConversation(userId: string, id: string, title: string) {
  await db
    .update(aiConversations)
    .set({ title: title.slice(0, 120) })
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)));
}

export async function archiveConversation(userId: string, id: string) {
  await db
    .update(aiConversations)
    .set({ archivedAt: new Date() })
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)));
}

export async function deleteConversation(userId: string, id: string) {
  await db
    .delete(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)));
}
