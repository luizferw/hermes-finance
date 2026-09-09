"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface ArchivedRow {
  id: string;
  name: string;
}

/**
 * The way back from an archive.
 *
 * Archiving is how budgets and cards are deleted — the record survives because
 * history points at it — so every list that hides archived rows owes the user a
 * way to see and restore them. Collapsed by default: this is a recovery path,
 * not something to scroll past every visit.
 */
export function ArchivedList({
  rows,
  label,
  restore,
}: {
  rows: ArchivedRow[];
  /** Plural noun for the summary line, e.g. "budgets". */
  label: string;
  restore: (id: string) => Promise<void>;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  if (rows.length === 0) return null;

  function onRestore(row: ArchivedRow) {
    setBusyId(row.id);
    startTransition(async () => {
      try {
        await restore(row.id);
        toast.success(`${row.name} restored`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not restore it");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <details className="rounded-xl border border-dashed border-border/60 px-4 py-3">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-2 hover:underline">
        {rows.length} archived {label}
      </summary>
      <ul className="mt-2 divide-y divide-dashed">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 py-2">
            <span className="truncate text-sm text-muted-foreground">{row.name}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={isPending && busyId === row.id}
              onClick={() => onRestore(row)}
            >
              {isPending && busyId === row.id ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon icon={ArrowTurnBackwardIcon} className="size-3" />
              )}
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
