import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, mcpAccessTokens } from "@kosh/db";
import { logAudit } from "@/modules/shared/audit";
import { MCP_READ_SCOPES, type Scope } from "./types";

const PREFIX = "kosh_mcp_";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readScopes(scopes: readonly string[]): Scope[] {
  return scopes.filter((scope): scope is Scope =>
    (MCP_READ_SCOPES as readonly string[]).includes(scope),
  );
}

/**
 * Mint a scoped MCP token. The plaintext is returned exactly once (the caller
 * shows it and forgets it); only the SHA-256 hash is stored. External MCP
 * access is opt-in — a token must be deliberately created.
 */
export async function createMcpToken(
  userId: string,
  name: string,
  scopes: Scope[],
): Promise<{ id: string; token: string }> {
  const safeScopes = readScopes(scopes);
  if (safeScopes.length === 0) throw new Error("At least one read scope is required.");
  const token = PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(mcpAccessTokens)
    .values({ userId, name, tokenHash: hashToken(token), scopes: safeScopes })
    .returning({ id: mcpAccessTokens.id });
  await logAudit({
    userId,
    action: "mcp_token.created",
    entityType: "mcp_access_token",
    entityId: row!.id,
    data: { name, scopes: safeScopes },
  });
  return { id: row!.id, token };
}

export async function listMcpTokens(userId: string) {
  const rows = await db
    .select({
      id: mcpAccessTokens.id,
      name: mcpAccessTokens.name,
      scopes: mcpAccessTokens.scopes,
      lastUsedAt: mcpAccessTokens.lastUsedAt,
      revokedAt: mcpAccessTokens.revokedAt,
      createdAt: mcpAccessTokens.createdAt,
    })
    .from(mcpAccessTokens)
    .where(eq(mcpAccessTokens.userId, userId))
    .orderBy(desc(mcpAccessTokens.createdAt));
  return rows.map((row) => ({ ...row, scopes: readScopes(row.scopes) }));
}

export async function revokeMcpToken(userId: string, id: string): Promise<void> {
  await db
    .update(mcpAccessTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpAccessTokens.id, id), eq(mcpAccessTokens.userId, userId)));
  await logAudit({
    userId,
    action: "mcp_token.revoked",
    entityType: "mcp_access_token",
    entityId: id,
  });
}

/** Resolve a bearer token → { userId, scopes } or null. Touches lastUsedAt. */
export async function verifyMcpToken(
  token: string,
): Promise<{ userId: string; scopes: Scope[] } | null> {
  if (!token.startsWith(PREFIX)) return null;
  const [row] = await db
    .select()
    .from(mcpAccessTokens)
    .where(
      and(
        eq(mcpAccessTokens.tokenHash, hashToken(token)),
        isNull(mcpAccessTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  await db
    .update(mcpAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpAccessTokens.id, row.id));
  return { userId: row.userId, scopes: readScopes(row.scopes) };
}
