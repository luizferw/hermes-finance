"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SparklesIcon,
  SentIcon,
  Add01Icon,
  Delete02Icon,
  SidebarRight01Icon,
  PulseIcon,
  Clock01Icon,
  CpuIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { AgentBlocks } from "@/components/home/agent-blocks";
import type { ResponseBlock } from "@/modules/agent/types";

interface ConversationSummary {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: string;
}
interface AiStatus {
  aiEnabled: boolean;
  hasKey: boolean;
  model: string;
  mcpEnabled: boolean;
}
interface Turn {
  role: "user" | "assistant";
  text?: string;
  blocks?: ResponseBlock[];
}

type Tab = "history" | "activity";

type StreamEvent =
  | { type: "progress"; event: string }
  | { type: "result"; data: { blocks: ResponseBlock[]; events: string[]; aiEnabled: boolean } }
  | { type: "error"; message: string };

/**
 * The Ask Kosh workspace — a first-class agentic screen, not a home widget.
 * Center is a calm conversation canvas with a persistent composer; the right
 * panel adapts between conversation history and live tool activity. The global
 * left sidebar (with Ask Kosh active) frames it.
 */
export function AskWorkspace({
  user,
  status,
  conversations: initialConversations,
  initialQuery,
  starters,
}: {
  user: { name: string };
  status: AiStatus;
  conversations: ConversationSummary[];
  initialQuery: string;
  starters: string[];
}) {
  const router = useRouter();
  const [conversations, setConversations] = React.useState(initialConversations);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [query, setQuery] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [events, setEvents] = React.useState<string[]>([]);
  const [aiOff, setAiOff] = React.useState(!status.aiEnabled);
  const [tab, setTab] = React.useState<Tab>("history");
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [mobilePanel, setMobilePanel] = React.useState(false);
  const [retryText, setRetryText] = React.useState<string | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const started = React.useRef(false);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, pending]);

  React.useEffect(() => {
    if (!mobilePanel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobilePanel(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobilePanel]);

  const ensureConversation = React.useCallback(async (): Promise<string | null> => {
    if (activeId) return activeId;
    try {
      const res = await fetch("/api/agent/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { data?: { conversation: ConversationSummary } };
      const conv = json.data?.conversation;
      if (!conv) return null;
      setActiveId(conv.id);
      setConversations((c) => [conv, ...c]);
      return conv.id;
    } catch {
      return null;
    }
  }, [activeId]);

  const refreshConversations = React.useCallback(async () => {
    try {
      const res = await fetch("/api/agent/conversations");
      const json = (await res.json()) as { data?: { conversations: ConversationSummary[] } };
      if (json.data) setConversations(json.data.conversations);
    } catch {
      /* non-fatal */
    }
  }, []);

  const send = React.useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || pending) return;
      setTurns((t) => [...t, { role: "user", text }]);
      setQuery("");
      setPending(true);
      setRetryText(null);
      setEvents([]);
      const convId = await ensureConversation();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, conversationId: convId ?? undefined }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("application/x-ndjson")) {
          throw new Error(res.status === 429 ? "rate_limited" : "request_failed");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let completed = false;
        for (;;) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const event = JSON.parse(line) as StreamEvent;
            if (event.type === "progress") {
              setEvents((current) =>
                current.at(-1) === event.event ? current : [...current, event.event],
              );
            } else if (event.type === "result") {
              completed = true;
              setAiOff(!event.data.aiEnabled);
              setEvents(event.data.events ?? []);
              setTurns((turns) => [
                ...turns,
                { role: "assistant", blocks: event.data.blocks },
              ]);
            } else {
              throw new Error("agent_failed");
            }
          }
          if (done) break;
        }
        if (!completed) throw new Error("empty_response");
        // Refresh the history list (title may have just been set).
        void refreshConversations();
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setTurns((t) => [...t, { role: "assistant", blocks: [{ type: "warning", text: "Stopped." }] }]);
        } else {
          const message = (err as Error).message === "rate_limited"
            ? "You’ve sent several requests quickly. Wait a moment, then try again."
            : "Kosh couldn’t finish that response. Your data was not changed.";
          setTurns((t) => [...t, { role: "assistant", blocks: [{ type: "warning", text: message }] }]);
          setRetryText(text);
        }
      } finally {
        setPending(false);
        abortRef.current = null;
      }
    },
    [pending, ensureConversation, refreshConversations],
  );

  // Auto-run a query handed over from the home launcher.
  React.useEffect(() => {
    if (initialQuery && !started.current) {
      started.current = true;
      void send(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  async function openConversation(id: string) {
    if (pending) return;
    try {
      const res = await fetch(`/api/agent/conversations/${id}`);
      const json = (await res.json()) as {
        data?: { messages: Turn[] };
      };
      if (!json.data) return;
      setActiveId(id);
      setTurns(
        json.data.messages.map((m) => ({
          role: m.role,
          text: m.text ?? undefined,
          blocks: m.blocks ?? undefined,
        })),
      );
      setMobilePanel(false);
    } catch {
      /* non-fatal */
    }
  }

  function newConversation() {
    setActiveId(null);
    setTurns([]);
    setQuery("");
    setEvents([]);
    taRef.current?.focus();
  }

  async function removeConversation(id: string) {
    await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" });
    setConversations((c) => c.filter((x) => x.id !== id));
    if (activeId === id) newConversation();
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(query);
    }
  }

  const hasThread = turns.length > 0;
  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Center workspace */}
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          title={conversations.find((c) => c.id === activeId)?.title ?? "Ask Kosh"}
          onNew={newConversation}
          onTogglePanel={() => {
            setPanelOpen((o) => !o);
            setMobilePanel((o) => !o);
          }}
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
            {!hasThread ? (
              <EmptyState name={user.name} aiOff={aiOff} starters={starters} onPick={(s) => void send(s)} />
            ) : (
              <div className="space-y-5">
                {aiOff && (
                  <p className="rounded-lg bg-warning/[0.07] px-3 py-2 text-xs text-muted-foreground ring-1 ring-inset ring-warning/15">
                    AI is off — answering with built-in rules. Enable Gemini in Settings → AI for full assistance.
                  </p>
                )}
                {turns.map((t, i) =>
                  t.role === "user" ? (
                    <article key={i} aria-label="Your message" className="flex justify-end">
                      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2 text-sm leading-6 text-foreground">
                        {t.text}
                      </p>
                    </article>
                  ) : (
                    <AgentBlocks
                      key={i}
                      blocks={t.blocks ?? []}
                      onConfirmDone={() => router.refresh()}
                      onFollowUp={(q) => void send(q)}
                    />
                  ),
                )}
                {pending && <WorkingIndicator events={events} />}
                {retryText && !pending && (
                  <button
                    type="button"
                    onClick={() => void send(retryText)}
                    className="text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Try again
                  </button>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>
        </div>

        <Composer
          ref={taRef}
          query={query}
          setQuery={setQuery}
          pending={pending}
          onSubmit={() => void send(query)}
          onStop={stop}
          onKeyDown={onKeyDown}
        />
      </div>

      {/* Right contextual panel (desktop) */}
      {panelOpen && (
        <ContextPanel
          className="hidden w-80 shrink-0 lg:flex"
          tab={tab}
          setTab={setTab}
          status={status}
          userName={user.name}
          conversations={conversations}
          activeId={activeId}
          onOpen={openConversation}
          onDelete={removeConversation}
          events={events}
          pending={pending}
        />
      )}

      {/* Mobile panel as an overlay sheet */}
      {mobilePanel && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ask Kosh context"
          className="fixed inset-0 z-40 lg:hidden"
        >
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobilePanel(false)} />
          <ContextPanel
            className="absolute inset-y-0 right-0 flex w-[88%] max-w-sm shadow-xl"
            tab={tab}
            setTab={setTab}
            status={status}
            userName={user.name}
            conversations={conversations}
            activeId={activeId}
            onOpen={openConversation}
            onDelete={removeConversation}
            events={events}
            pending={pending}
          />
        </div>
      )}
    </div>
  );
}

function WorkspaceHeader({
  title,
  onNew,
  onTogglePanel,
}: {
  title: string;
  onNew: () => void;
  onTogglePanel: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4 md:px-6">
      <HugeiconsIcon icon={SparklesIcon} className="size-5 shrink-0 text-primary" strokeWidth={1.8} />
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
      <button
        type="button"
        onClick={onNew}
        className="inline-flex items-center gap-1.5 rounded-full bg-card/70 px-3 py-1.5 text-xs font-medium text-foreground ring-1 ring-inset ring-border/70 transition-colors hover:bg-card"
      >
        <HugeiconsIcon icon={Add01Icon} className="size-3.5" strokeWidth={2} />
        New
      </button>
      <button
        type="button"
        onClick={onTogglePanel}
        aria-label="Toggle context panel"
        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <HugeiconsIcon icon={SidebarRight01Icon} className="size-[18px]" strokeWidth={1.8} />
      </button>
    </header>
  );
}

function EmptyState({
  name,
  aiOff,
  starters,
  onPick,
}: {
  name: string;
  aiOff: boolean;
  starters: string[];
  onPick: (s: string) => void;
}) {
  return (
    <div className="flex flex-col items-center pt-8 text-center md:pt-16">
      <div aria-hidden className="kosh-mark mb-6 size-14 rounded-2xl bg-primary/10 ring-1 ring-inset ring-primary/15" />
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Hello, {name.split(" ")[0]}
      </h1>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        Ask about your accounts, spending, budgets, bills, recurring commitments, or goals.
        Kosh checks your data before answering and stays read-only.
      </p>
      {aiOff && (
        <p className="mt-2 text-xs text-warning">AI is off — only built-in answers are available.</p>
      )}
      <div className="mt-7 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {starters.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-xl bg-card/70 px-4 py-3 text-left text-sm text-foreground ring-1 ring-inset ring-border/70 transition-[transform,background-color] hover:-translate-y-px hover:bg-card"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

const Composer = React.forwardRef<
  HTMLTextAreaElement,
  {
    query: string;
    setQuery: (s: string) => void;
    pending: boolean;
    onSubmit: () => void;
    onStop: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  }
>(function Composer(
  { query, setQuery, pending, onSubmit, onStop, onKeyDown },
  ref,
) {
  return (
    <div className="shrink-0 px-4 pb-16 md:px-6 md:pb-4">
      <div className="mx-auto w-full max-w-2xl">
        <div className="glass-panel flex items-end gap-2 rounded-2xl px-3 py-2.5 shadow-sm transition-shadow focus-within:shadow-md">
          <textarea
            ref={ref}
            rows={1}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={onKeyDown}
            placeholder="Ask about your spending, bills, budgets, or goals…"
            aria-label="Message Kosh"
            className="max-h-[200px] min-h-[24px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground/80"
          />
          {pending ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground transition-colors hover:bg-foreground/15"
            >
              <span className="size-3 rounded-[3px] bg-foreground" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!query.trim()}
              aria-label="Send"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
            >
              <HugeiconsIcon icon={SentIcon} className="size-4" strokeWidth={1.8} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[0.6875rem] text-muted-foreground/70">
          Read-only answers from your Kosh data. Enter to send · Shift+Enter for a new line.
        </p>
      </div>
    </div>
  );
});

function ContextPanel({
  className,
  tab,
  setTab,
  status,
  userName,
  conversations,
  activeId,
  onOpen,
  onDelete,
  events,
  pending,
}: {
  className?: string;
  tab: Tab;
  setTab: (t: Tab) => void;
  status: AiStatus;
  userName: string;
  conversations: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  events: string[];
  pending: boolean;
}) {
  const tabs: Array<{ id: Tab; label: string; icon: typeof Clock01Icon; badge?: number }> = [
    { id: "history", label: "History", icon: Clock01Icon },
    { id: "activity", label: "Activity", icon: PulseIcon },
  ];
  return (
    <aside aria-label="Ask Kosh context" className={cn("flex-col border-l border-border/60 bg-background/60", className)}>
      <div className="flex shrink-0 gap-1 border-b border-border/60 p-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
              tab === t.id ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <HugeiconsIcon icon={t.icon} className="size-3.5" strokeWidth={1.8} />
            {t.label}
            {t.badge ? <span className="rounded-full bg-primary/15 px-1.5 text-[0.625rem] text-primary">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "history" && (
          <ul className="space-y-0.5">
            {conversations.length === 0 && <li className="px-2 py-3 text-xs text-muted-foreground">No conversations yet.</li>}
            {conversations.map((c) => (
              <li key={c.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  className={cn(
                    "min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    activeId === c.id ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(c.id)}
                  aria-label="Delete conversation"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" strokeWidth={1.8} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {tab === "activity" && (
          <div className="space-y-2">
            {events.length === 0 && !pending && <p className="px-2 py-3 text-xs text-muted-foreground">Tool activity from the current turn appears here.</p>}
            {events.map((e, i) => (
              <p key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary/60" />
                {e}
              </p>
            ))}
            {pending && <p className="text-xs text-muted-foreground">Working…</p>}
          </div>
        )}

      </div>

      {/* Status footer */}
      <div className="shrink-0 space-y-1.5 border-t border-border/60 p-3 text-xs">
        <StatusRow icon={CpuIcon} label="Model" value={status.aiEnabled ? status.model : "AI off"} ok={status.aiEnabled} />
        <StatusRow icon={SparklesIcon} label="MCP" value={status.mcpEnabled ? "Enabled" : "Disabled"} ok={status.mcpEnabled} />
        <p className="pt-1 text-[0.6875rem] text-muted-foreground/70">
          {userName} · Read-only. Only the messages and scoped tool results needed to answer are sent to the model.
        </p>
      </div>
    </aside>
  );
}

function StatusRow({
  icon,
  label,
  value,
  ok,
}: {
  icon: typeof CpuIcon;
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <HugeiconsIcon icon={icon} className="size-3.5 shrink-0" strokeWidth={1.8} />
      <span>{label}</span>
      <span className={cn("ml-auto inline-flex items-center gap-1.5 font-medium", ok ? "text-foreground" : "text-muted-foreground")}>
        <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-muted-foreground/40")} />
        {value}
      </span>
    </div>
  );
}

function WorkingIndicator({ events }: { events: string[] }) {
  const last = events[events.length - 1];
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="flex gap-1">
        <span className="size-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:-0.2s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:-0.1s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-primary/60" />
      </span>
      {last ?? "Kosh is working…"}
    </p>
  );
}
