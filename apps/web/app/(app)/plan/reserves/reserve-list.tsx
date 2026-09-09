"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { deleteFinancialReserve, updateFinancialReserve } from "@/modules/finance/mutations";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { EditReserveDialog } from "./edit-reserve-dialog";

export interface ReserveRow {
  id: string;
  name: string;
  kind: "hard" | "soft";
  amountMinor: number;
  currencyCode: string;
  isActive: boolean;
}

/**
 * Only an active reserve counts toward safe-to-spend (hard) or a purchase
 * simulation's warnings (soft) — the toggle is the deliberate way to retire
 * one without losing its history to a delete.
 */
export function ReserveList({ reserves }: { reserves: ReserveRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();
  const [editingReserve, setEditingReserve] = React.useState<ReserveRow | null>(null);

  function toggleActive(reserve: ReserveRow) {
    setBusyId(reserve.id);
    startTransition(async () => {
      try {
        await updateFinancialReserve(reserve.id, { isActive: !reserve.isActive });
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update the reserve");
      } finally {
        setBusyId(null);
      }
    });
  }

  function remove(reserve: ReserveRow) {
    setBusyId(reserve.id);
    startTransition(async () => {
      try {
        await deleteFinancialReserve(reserve.id);
        toast.success(`${reserve.name} deleted`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete the reserve");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <ul className="divide-y divide-dashed">
      {reserves.map((reserve) => (
        <li
          key={reserve.id}
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0",
            !reserve.isActive && "opacity-60",
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <Switch
              checked={reserve.isActive}
              disabled={isPending && busyId === reserve.id}
              onCheckedChange={() => toggleActive(reserve)}
              aria-label={`${reserve.isActive ? "Deactivate" : "Activate"} ${reserve.name}`}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{reserve.name}</p>
              <Badge variant={reserve.kind === "hard" ? "outline" : "secondary"} className="mt-0.5 text-[10px]">
                {reserve.kind === "hard" ? "Hard — never violated" : "Soft — warns only"}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-amount text-sm tabular-nums">
              {formatMoney(reserve.amountMinor, reserve.currencyCode)}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={isPending && busyId === reserve.id}
              onClick={() => setEditingReserve(reserve)}
              aria-label={`Edit ${reserve.name}`}
            >
              <HugeiconsIcon icon={PencilEdit02Icon} className="size-4 text-muted-foreground" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={isPending && busyId === reserve.id}
              onClick={() => remove(reserve)}
              aria-label={`Delete ${reserve.name}`}
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-4 text-muted-foreground" />
            </Button>
          </div>
        </li>
      ))}
      {editingReserve && (
        <EditReserveDialog
          reserve={editingReserve}
          open={!!editingReserve}
          onOpenChange={(open) => {
            if (!open) setEditingReserve(null);
          }}
        />
      )}
    </ul>
  );
}
