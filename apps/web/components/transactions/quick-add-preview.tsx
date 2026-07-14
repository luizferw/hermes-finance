"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDownLeft01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { formatMoney } from "@/lib/format";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { QuickAdd } from "@/hooks/use-quick-add";

const NONE = "__none__";

/**
 * The transaction a command resolves to, shown before it is saved. Parsed
 * fields are read-only; account and category are editable inline so the user
 * confirms rather than trusts. Enter (handled by the caller) or the button
 * commits.
 */
export function QuickAddPreview({
  qa,
  onCommitted,
  className,
}: {
  qa: QuickAdd;
  onCommitted?: () => void;
  className?: string;
}) {
  const { draft, account, accounts, categories, resolvedCategory, saving } = qa;

  const [acctOverride, setAcctOverride] = React.useState<string>();
  const [catOverride, setCatOverride] = React.useState<string>();
  // New parse = fresh intent: drop any pending inline edits. Reset during
  // render (not in an effect) when the draft's identity changes.
  const sig = `${draft?.amountMinor}|${draft?.merchant}|${draft?.type}`;
  const [prevSig, setPrevSig] = React.useState(sig);
  if (sig !== prevSig) {
    setPrevSig(sig);
    setAcctOverride(undefined);
    setCatOverride(undefined);
  }

  if (!draft || !account) return null;

  const income = draft.type === "income";
  const selectedAccount = acctOverride ?? account.id;
  const selectedCategory = catOverride ?? resolvedCategory?.id ?? NONE;
  const accountCurrency =
    accounts.find((a) => a.id === selectedAccount)?.currencyCode ?? account.currencyCode;

  const uncategorized = selectedCategory === NONE;

  async function commit(review = false) {
    const ok = await qa.save({
      accountId: selectedAccount,
      categoryId: uncategorized ? null : selectedCategory,
      review,
    });
    if (ok) onCommitted?.();
  }

  return (
    <div
      className={cn(
        "glass-panel rounded-2xl p-4 shadow-sm",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-200",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
            income ? "bg-primary/15 text-primary" : "bg-foreground/[0.06] text-foreground",
          )}
        >
          <HugeiconsIcon
            icon={income ? ArrowDownLeft01Icon : ArrowUpRight01Icon}
            className="size-[18px]"
            strokeWidth={1.8}
          />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {draft.description || draft.merchant || "Transaction"}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{formatDateShort(draft.date)}</span>
            {draft.method && (
              <>
                <span aria-hidden>·</span>
                <span className="uppercase tracking-wide">{draft.method}</span>
              </>
            )}
          </div>
        </div>

        <span
          className={cn(
            "shrink-0 font-amount text-lg font-medium tabular-nums",
            income ? "text-primary" : "text-foreground",
          )}
        >
          {formatMoney(income ? draft.amountMinor : -draft.amountMinor, accountCurrency, {
            signDisplay: "always",
          })}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Select value={selectedAccount} onValueChange={setAcctOverride}>
          <SelectTrigger className="h-9 w-full text-xs">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={selectedCategory} onValueChange={setCatOverride}>
          <SelectTrigger className="h-9 w-full text-xs">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Uncategorized</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 flex gap-2">
        <Button onClick={() => commit(false)} disabled={saving} className="flex-1" size="sm">
          {saving ? "Saving…" : "Add transaction"}
        </Button>
        {uncategorized && (
          <Button
            onClick={() => commit(true)}
            disabled={saving}
            variant="ghost"
            size="sm"
            title="Save without a category — it waits in your inbox until you confirm it"
          >
            Review later
          </Button>
        )}
      </div>
    </div>
  );
}
