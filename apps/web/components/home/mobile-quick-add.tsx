"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuickAdd } from "@/hooks/use-quick-add";
import { QuickAddPreview } from "@/components/transactions/quick-add-preview";
import { SUGGESTIONS, type SuggestionAction } from "./suggestions";

/**
 * Mobile capture, thumb-first: a big input that takes the same "coffee 180 upi"
 * grammar as everywhere else, a live preview to confirm, and one-tap
 * suggestions. Lives inside the bottom sheet opened by the nav's + button.
 */
export function MobileQuickAdd({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const qa = useQuickAdd(query, {
    onSaved: () => {
      setQuery("");
      router.refresh();
    },
  });

  // Focus once the sheet has settled (autofocus inside a portal is unreliable).
  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  function runAction(action: SuggestionAction) {
    if (action.type === "route") {
      onDone();
      router.push(action.href);
    } else {
      setQuery(action.text);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="space-y-3 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        enterKeyHint="done"
        placeholder="coffee 180 upi"
        aria-label="Log a spend"
        className="w-full rounded-xl bg-foreground/[0.04] px-4 py-4 text-lg outline-none ring-1 ring-border/70 ring-inset placeholder:text-muted-foreground/70 focus:ring-2 focus:ring-ring/60"
      />

      {qa.canSave ? (
        <QuickAddPreview qa={qa} onCommitted={onDone} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => runAction(s.action)}
              className="inline-flex items-center gap-2 rounded-full bg-foreground/[0.04] px-3.5 py-2 text-sm text-muted-foreground ring-1 ring-border/70 ring-inset active:scale-[0.98]"
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
