"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreVerticalIcon } from "@hugeicons/core-free-icons";
import { deleteRecurring, setRecurringActive } from "@/modules/recurring/mutations";
import { formatAbsAmount, formatDate, formatRelativeDays } from "@/lib/format";
import { daysBetween, todayIso } from "@kosh/domain";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CategoryBadge } from "@/components/transactions/category-badge";

export interface RecurringRow {
  id: string;
  name: string;
  type: string;
  amountMinor: number;
  currencyCode: string;
  interval: string;
  nextRunDate: string;
  lastRunDate: string | null;
  isActive: boolean;
  accountName: string;
  category: { id: string; name: string; color: string | null } | null;
}

const TYPE_LABEL: Record<string, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

export function RecurringList({ items }: { items: RecurringRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();
  const today = todayIso();

  function act(id: string, action: () => Promise<unknown>, message: string) {
    setBusyId(id);
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

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <ul className="divide-y divide-dashed">
        {items.map((item) => {
          const days = daysBetween(today, item.nextRunDate);
          const isDue = item.isActive && days <= 0;
          return (
            <li
              key={item.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3",
                !item.isActive && "opacity-60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{item.name}</p>
                  <Badge
                    variant="secondary"
                    className={
                      item.type === "income"
                        ? "bg-success/10 text-success"
                        : item.type === "transfer"
                          ? "bg-primary/10 text-primary"
                          : undefined
                    }
                  >
                    {TYPE_LABEL[item.type] ?? item.type}
                  </Badge>
                  {isDue && (
                    <Badge className="bg-warning/15 text-warning-foreground dark:text-warning">
                      Due
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.interval} from {item.accountName} - next{" "}
                  {formatRelativeDays(days)} ({formatDate(item.nextRunDate)})
                  {item.lastRunDate && ` - last ran ${formatDate(item.lastRunDate)}`}
                </p>
              </div>
              <span className="hidden sm:block">
                <CategoryBadge category={item.category} />
              </span>
              <span className="font-amount text-sm">
                {formatAbsAmount(item.amountMinor, item.currencyCode)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={isPending && busyId === item.id}
                  >
                    <HugeiconsIcon icon={MoreVerticalIcon} />
                    <span className="sr-only">Recurring actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      act(
                        item.id,
                        () => setRecurringActive(item.id, !item.isActive),
                        item.isActive ? "Recurring item paused" : "Recurring item resumed",
                      )
                    }
                  >
                    {item.isActive ? "Pause" : "Resume"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() =>
                      act(item.id, () => deleteRecurring(item.id), "Recurring item deleted")
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
