import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/app-shell/page-header";
import { getAiStatus } from "@/modules/agent/provider";
import { listAgentActivity } from "@/modules/agent/recorder";
import { listMcpTokens } from "@/modules/agent/mcp-tokens";
import { formatDate } from "@/lib/format";
import { McpTokenManager } from "./mcp-token-manager";

export const metadata: Metadata = { title: "AI & MCP" };

export default async function AiSettingsPage() {
  const user = await requireUser();
  const status = getAiStatus();
  if (!status.aiEnabled && !status.mcpEnabled) notFound();
  const [activity, tokens] = await Promise.all([
    listAgentActivity(user.id, 25),
    listMcpTokens(user.id),
  ]);

  return (
    <>
      <PageHeader title="AI & MCP" description="Assistant, data boundary, and external access" />
      <main className="mx-auto w-full max-w-3xl space-y-10 px-4 py-6 md:px-8 md:py-8">
        {/* Data boundary — explicit and honest. */}
        <section>
          <h2 className="micro-label">Assistant</h2>
          <div className="mt-3 space-y-2 text-sm">
            <Row label="AI assistant" value={status.aiEnabled ? "Enabled" : "Disabled"} tone={status.aiEnabled ? "on" : "off"} />
            <Row label="Model" value={status.aiEnabled ? status.model : "—"} />
            <Row label="API key configured" value={status.hasKey ? "Yes" : "No"} />
            <Row label="External MCP access" value={status.mcpEnabled ? "Enabled" : "Disabled"} tone={status.mcpEnabled ? "on" : "off"} />
          </div>
          <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted-foreground">
            {status.aiEnabled ? (
              <>When you ask Kosh a question, your question, recent conversation context, and the specific tool results needed to answer it are sent to Google&apos;s Gemini API ({status.model}) — never your full database, passwords, or unrelated data. Every figure is computed by Kosh; the model only interprets and explains. Set <code>KOSH_AI_ENABLED=false</code> to disable; Kosh keeps working with its built-in deterministic answers.</>
            ) : (
              <>AI is off. Kosh answers a fixed set of questions deterministically. To enable Gemini, set <code>GEMINI_API_KEY</code> and <code>KOSH_AI_ENABLED=true</code>. Data leaves your instance only when AI is enabled.</>
            )}
          </p>
        </section>

        {/* Scoped external MCP tokens. */}
        <section>
          <McpTokenManager tokens={tokens.map((t) => ({
            id: t.id,
            name: t.name,
            scopes: t.scopes,
            lastUsedAt: t.lastUsedAt ? formatDate(t.lastUsedAt.toISOString().slice(0, 10)) : null,
            revoked: !!t.revokedAt,
          }))} mcpEnabled={status.mcpEnabled} />
        </section>

        {/* AI activity — every action the assistant took. */}
        <section>
          <h2 className="micro-label">AI activity</h2>
          {activity.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
              No assistant actions yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border/50">
              {activity.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{a.toolName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{a.source}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <StatusPill status={a.status} />
                    <span className="font-amount text-xs text-muted-foreground tabular-nums">
                      {formatDate(a.createdAt.toISOString().slice(0, 10))}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "on" | "off" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={tone === "on" ? "font-medium text-success" : tone === "off" ? "text-muted-foreground" : "font-medium"}>
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const ok = status === "completed" || status === "already_completed";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${ok ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
      {status}
    </span>
  );
}
