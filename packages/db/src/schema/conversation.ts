import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { timestamps } from "./helpers";
import { users } from "./auth";

/**
 * A persistent Ask-Kosh conversation. The agent workspace lists, reopens, and
 * resumes these. Messages hold rendered response blocks (jsonb) so a reopened
 * thread shows the exact financial interfaces it did originally — figures are
 * never recomputed by the model on reload.
 */
export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    pinned: boolean("pinned").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("ai_conversations_user_idx").on(t.userId, t.updatedAt),
    uniqueIndex("ai_conversations_id_user_unique").on(t.id, t.userId),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "user" | "assistant"
    text: text("text"),
    /** Rendered ResponseBlock[] for assistant turns. */
    blocks: jsonb("blocks").$type<unknown[]>(),
    /** Neutral model-conversation content replayed on the next turn. */
    modelContents: jsonb("model_contents").$type<unknown[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("ai_messages_conversation_idx").on(t.conversationId, t.createdAt),
    foreignKey({
      columns: [t.conversationId, t.userId],
      foreignColumns: [aiConversations.id, aiConversations.userId],
      name: "ai_messages_conversation_owner_fk",
    }).onDelete("cascade"),
  ],
);
