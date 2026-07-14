"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { mintMcpToken, revokeToken } from "@/modules/agent/actions";
import { MCP_READ_SCOPES, type Scope } from "@/modules/agent/types";

const SCOPES: Scope[] = [...MCP_READ_SCOPES];

interface TokenView {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  revoked: boolean;
}

/**
 * Create, list, and revoke scoped MCP tokens. A new token's plaintext is shown
 * exactly once. External access is opt-in (requires KOSH_MCP_ENABLED on the
 * server too).
 */
export function McpTokenManager({
  tokens,
  mcpEnabled,
}: {
  tokens: TokenView[];
  mcpEnabled: boolean;
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [picked, setPicked] = React.useState<Scope[]>(["finance:read"]);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function create() {
    if (!name.trim() || picked.length === 0) return;
    setBusy(true);
    try {
      const { token } = await mintMcpToken({ name: name.trim(), scopes: picked });
      setSecret(token);
      setName("");
      router.refresh();
    } catch {
      toast.error("Could not create token");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await revokeToken(id);
    toast.success("Token revoked");
    router.refresh();
  }

  return (
    <div>
      <h2 className="micro-label">External MCP tokens</h2>
      <p className="mt-2 text-xs text-muted-foreground">
        External MCP access is read-only. Changes must be made and confirmed inside Kosh.
      </p>
      {!mcpEnabled && (
        <p className="mt-2 text-xs text-warning">
          MCP is disabled on the server. Set <code>KOSH_MCP_ENABLED=true</code> to allow external clients to use these tokens.
        </p>
      )}

      {secret && (
        <div className="mt-3 rounded-xl bg-success/[0.08] p-3 ring-1 ring-inset ring-success/20">
          <p className="text-xs font-medium text-foreground">Copy this token now — it won&apos;t be shown again.</p>
          <code className="mt-1.5 block overflow-x-auto rounded-md bg-background px-2 py-1.5 font-mono text-xs">{secret}</code>
          <button type="button" onClick={() => { navigator.clipboard?.writeText(secret); toast.success("Copied"); }} className="mt-2 text-xs font-medium text-primary hover:underline">
            Copy
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name (e.g. Claude Desktop)"
          className="min-w-48 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        />
        <button type="button" onClick={create} disabled={busy || !name.trim()} className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Creating…" : "Create token"}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SCOPES.map((s) => {
          const on = picked.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s) : [...p, s]))}
              className={`rounded-full px-2.5 py-1 text-xs ring-1 ring-inset transition-colors ${on ? "bg-primary/10 text-primary ring-primary/25" : "text-muted-foreground ring-border hover:bg-foreground/[0.04]"}`}
            >
              {s}
            </button>
          );
        })}
      </div>

      {tokens.length > 0 && (
        <ul className="mt-4 divide-y divide-border/50">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="min-w-0">
                <span className={t.revoked ? "text-muted-foreground line-through" : "font-medium"}>{t.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{t.scopes.join(", ") || "no active scopes"}</span>
                <span className="ml-2 text-xs text-muted-foreground/70">{t.lastUsedAt ? `used ${t.lastUsedAt}` : "never used"}</span>
              </span>
              {!t.revoked && (
                <button type="button" onClick={() => revoke(t.id)} className="text-xs font-medium text-destructive hover:underline">
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
