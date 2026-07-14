"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreVerticalIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { BillState } from "@kosh/domain";
import { deleteBill, markBillPaid, updateBill } from "@/modules/bills/mutations";
import { formatAbsAmount, formatDate, formatRelativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { CategoryBadge } from "@/components/transactions/category-badge";

export interface BillRow {
  id: string;
  name: string;
  expectedAmountMinor: number;
  currencyCode: string;
  recurrence: string;
  nextDueDate: string;
  lastPaidDate: string | null;
  isActive: boolean;
  accountName: string | null;
  category: { id: string; name: string; color: string | null } | null;
  state: BillState;
  daysUntilDue: number;
}

const STATE_BADGE: Record<BillState, { label: string; className: string }> = {
  overdue: { label: "Overdue", className: "bg-destructive/10 text-destructive" },
  due_soon: {
    label: "Due soon",
    className: "bg-warning/15 text-warning-foreground dark:text-warning",
  },
  upcoming: { label: "Upcoming", className: "bg-muted text-muted-foreground" },
  inactive: { label: "Paused", className: "bg-muted text-muted-foreground" },
};

export function BillList({ bills }: { bills: BillRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  function act(billId: string, action: () => Promise<unknown>, message: string) {
    setBusyId(billId);
    startTransition(async () => {
      try {
        await action();
        toast.success(message);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    });
  }

  const ordered = [...bills].sort((a, b) => {
    const rank = (s: BillState) =>
      s === "overdue" ? 0 : s === "due_soon" ? 1 : s === "upcoming" ? 2 : 3;
    return rank(a.state) - rank(b.state) || (a.nextDueDate < b.nextDueDate ? -1 : 1);
  });

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <ul className="divide-y divide-dashed">
        {ordered.map((bill) => {
          const badge = STATE_BADGE[bill.state];
          return (
            <li
              key={bill.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3",
                !bill.isActive && "opacity-60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{bill.name}</p>
                  <Badge className={cn("border-transparent", badge.className)}>
                    {badge.label}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {bill.state === "overdue"
                    ? `was due ${formatDate(bill.nextDueDate)}`
                    : `due ${formatRelativeDays(bill.daysUntilDue)} · ${formatDate(bill.nextDueDate)}`}
                  {" · "}
                  {bill.recurrence}
                  {bill.accountName && ` · ${bill.accountName}`}
                </p>
                <div className="mt-1 flex items-center gap-2 sm:hidden">
                  <CategoryBadge
                    category={bill.category}
                    className="px-1.5 py-0 text-[10px]"
                  />
                </div>
              </div>
              <span className="hidden sm:block">
                <CategoryBadge category={bill.category} />
              </span>
              <span className="font-amount text-sm">
                {formatAbsAmount(bill.expectedAmountMinor, bill.currencyCode)}
              </span>
              {bill.isActive && bill.state !== "upcoming" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="hidden h-7 text-xs sm:flex"
                  disabled={isPending && busyId === bill.id}
                  onClick={() =>
                    act(
                      bill.id,
                      () => markBillPaid({ billId: bill.id }),
                      `${bill.name} marked paid`,
                    )
                  }
                >
                  {isPending && busyId === bill.id ? (
                    <Spinner className="size-3" />
                  ) : (
                    <HugeiconsIcon icon={Tick02Icon} className="size-3" />
                  )}
                  Mark paid
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8">
                    <HugeiconsIcon icon={MoreVerticalIcon} />
                    <span className="sr-only">Bill actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="sm:hidden"
                    onClick={() =>
                      act(
                        bill.id,
                        () => markBillPaid({ billId: bill.id }),
                        `${bill.name} marked paid`,
                      )
                    }
                  >
                    Mark paid
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      act(
                        bill.id,
                        () => updateBill(bill.id, { isActive: !bill.isActive }),
                        bill.isActive ? "Bill paused" : "Bill resumed",
                      )
                    }
                  >
                    {bill.isActive ? "Pause" : "Resume"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() =>
                      act(bill.id, () => deleteBill(bill.id), "Bill deleted")
                    }
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
