"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { SentIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { useQuickAdd } from "@/hooks/use-quick-add";
import { QuickAddPreview } from "@/components/transactions/quick-add-preview";
import { SUGGESTIONS, type SuggestionAction } from "./suggestions";

/**
 * Home launcher for Ask Kosh — NOT the full conversation. Typing a spend
 * ("coffee 180 upi") still gets an instant local quick-add (no round-trip).
 * Anything else opens the dedicated /ask workspace with the message prefilled,
 * where the agent, history, tools and approvals live.
 */
export function AskKosh() {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const qa = useQuickAdd(query, {
    onSaved: () => {
      setQuery("");
      router.refresh();
    },
  });
  const showPreview = qa.canSave;

  function openWorkspace(message: string) {
    const q = message.trim();
    router.push(q ? `/ask?q=${encodeURIComponent(q)}` : "/ask");
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (qa.canSave) {
      void qa.save();
      return;
    }
    openWorkspace(query);
  }

  function runAction(action: SuggestionAction) {
    if (action.type === "route") router.push(action.href);
    else if (action.type === "prefill") {
      setQuery(action.text);
      inputRef.current?.focus();
    } else openWorkspace(action.text);
  }

  return (
    <div>
      <form onSubmit={onSubmit}>
        <div
          className={cn(
            "glass-panel group flex items-center gap-3 rounded-2xl px-4 py-3.5 shadow-sm",
            "transition-shadow duration-[var(--duration-state)] focus-within:shadow-md",
          )}
        >
          <HugeiconsIcon icon={SparklesIcon} className="size-5 shrink-0 text-primary" strokeWidth={1.8} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask kosh, or log a spend — try “coffee 180 upi”"
            aria-label="Ask kosh or log a spend"
            className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/80"
          />
          {query.trim() && (
            <button
              type="submit"
              aria-label={qa.canSave ? "Save" : "Open Ask Kosh"}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95"
            >
              <HugeiconsIcon icon={SentIcon} className="size-4" strokeWidth={1.8} />
            </button>
          )}
        </div>
      </form>

      {showPreview ? (
        <QuickAddPreview qa={qa} className="mt-3" onCommitted={() => setQuery("")} />
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => runAction(s.action)}
              className={cn(
                "inline-flex items-center gap-2 rounded-full bg-card/70 py-1.5 pr-3.5 pl-3 text-sm text-muted-foreground ring-1 ring-border/70 outline-none ring-inset",
                "transition-[color,background-color,transform] duration-[var(--duration-state)] ease-[var(--ease-out-quint)]",
                "hover:-translate-y-px hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
              )}
            >
              <HugeiconsIcon icon={s.icon} className="size-4 shrink-0" strokeWidth={1.8} />
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
