import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { env } from "@/lib/env";
import { getUserSettings } from "@/modules/settings/queries";
import { MCP_TOOLS } from "@/modules/agent/registry";
import { verifyMcpToken } from "@/modules/agent/mcp-tokens";
import type { Scope, ToolContext } from "@/modules/agent/types";
import { logAudit } from "@/modules/shared/audit";

/**
 * Kosh's real MCP server (Streamable HTTP) for external clients. Authenticated
 * by a scoped bearer token — never the browser session cookie — and tenant-
 * scoped to the token's user. External access is intentionally read-only;
 * writes remain in Kosh's authenticated confirmation flow.
 *
 * Disabled unless KOSH_MCP_ENABLED=true.
 */
const baseHandler = createMcpHandler(
  (server) => {
    for (const tool of MCP_TOOLS) {
      const shape =
        (tool.input as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ??
        {};
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: shape,
        },
        async (args: Record<string, unknown>, extra: { authInfo?: AuthInfo }) => {
          const auth = extra.authInfo;
          const userId = auth?.extra?.userId as string | undefined;
          const scopes = (auth?.scopes ?? []) as Scope[];
          if (!userId) {
            return { content: [{ type: "text" as const, text: "Unauthorized." }], isError: true };
          }
          if (!scopes.includes(tool.requiredScope)) {
            return {
              content: [{ type: "text" as const, text: `Missing scope ${tool.requiredScope}.` }],
              isError: true,
            };
          }
          const currency = (await getUserSettings(userId)).currencyCode;
          const ctx: ToolContext = { userId, scopes, currency };

          try {
            const input = tool.input.parse(args);
            const res = await tool.execute(ctx, input);
            await logAudit({
              userId,
              action: "agent.tool.read",
              entityType: "agent_tool",
              entityId: tool.name,
              data: { source: "mcp", status: "completed" },
            });
            return { content: [{ type: "text" as const, text: JSON.stringify(res.forModel) }] };
          } catch {
            await logAudit({
              userId,
              action: "agent.tool.read",
              entityType: "agent_tool",
              entityId: tool.name,
              data: { source: "mcp", status: "failed" },
            }).catch(() => undefined);
            return {
              content: [{ type: "text" as const, text: "Tool failed." }],
              isError: true,
            };
          }
        },
      );
    }
  },
  { serverInfo: { name: "kosh", version: "1.0.0" } },
  { basePath: "/api" },
);

const authed = withMcpAuth(
  baseHandler,
  async (_req, bearer): Promise<AuthInfo | undefined> => {
    if (!bearer) return undefined;
    const resolved = await verifyMcpToken(bearer);
    if (!resolved) return undefined;
    return {
      token: bearer,
      clientId: "mcp",
      scopes: resolved.scopes,
      extra: { userId: resolved.userId },
    };
  },
  { required: true },
);

async function handler(req: Request): Promise<Response> {
  if (!env().KOSH_MCP_ENABLED) {
    return new Response(
      JSON.stringify({ error: "MCP is disabled. Set KOSH_MCP_ENABLED=true." }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  return authed(req);
}

export { handler as GET, handler as POST };
