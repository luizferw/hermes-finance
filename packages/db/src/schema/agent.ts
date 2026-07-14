import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./helpers";
import { users } from "./auth";

/**
 * Every agent/MCP tool invocation that mutates data lands here. Doubles as the
 * idempotency store (unique `idempotency_key`) and the user-facing "AI
 * activity" surface. Read tools are not recorded; writes always are.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Stable per-action key; a retry with the same key is a no-op. */
    idempotencyKey: text("idempotency_key").notNull(),
    toolName: text("tool_name").notNull(),
    /** completed | rejected | cancelled | validation_failed | … */
    status: text("status").notNull(),
    /** Where the request came from: "session" (in-app agent) or "mcp". */
    source: text("source").notNull().default("session"),
    /** Compact, non-sensitive summary of what was done (no full payloads). */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    /** Primary affected record, for the activity drill-down. */
    entityId: text("entity_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("agent_actions_idem_unique").on(t.idempotencyKey),
    index("agent_actions_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * Scoped tokens that let an external MCP client act for one user. Only the
 * SHA-256 hash is stored; the plaintext is shown once at creation. Disabled by
 * default — a user must explicitly mint a token.
 */
export const mcpAccessTokens = pgTable(
  "mcp_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 hex of the bearer token. */
    tokenHash: text("token_hash").notNull(),
    /** Granted external read scopes, e.g. ["finance:read","rules:read"]. */
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mcp_tokens_hash_unique").on(t.tokenHash),
    index("mcp_tokens_user_idx").on(t.userId),
  ],
);
