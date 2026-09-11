"use server";

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { env } from "@/lib/env";
import { ApiError } from "@/modules/shared/api";
import { createMcpToken, revokeMcpToken } from "./mcp-tokens";
import { MCP_SCOPES, type Scope } from "./types";

const scopeEnum = z.enum(MCP_SCOPES);

const mintSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(scopeEnum).min(1),
});

/** Mint a scoped MCP token. Returns the plaintext exactly once. */
export async function mintMcpToken(input: { name: string; scopes: Scope[] }) {
  if (!env().KOSH_MCP_ENABLED) {
    throw new ApiError(404, "not_found", "MCP is disabled.");
  }
  const user = await requireUser();
  const { name, scopes } = mintSchema.parse(input);
  return createMcpToken(user.id, name, scopes);
}

export async function revokeToken(id: string) {
  const user = await requireUser();
  await revokeMcpToken(user.id, z.string().uuid().parse(id));
}
