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
import type { CategoryOption } from "@/components/transactions/category-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CategoryBadge } from "@/components/transactions/category-badge";
import { EditRecurringDialog } from "./edit-recurring-dialog";

export interface RecurringRow {
  id: string;
  name: string;
  /** Widened because the column reuses the shared transaction enum — see EDITABLE_TYPES. */
  type: "income" | "expense" | "transfer" | "adjustment" | "opening_balance";
  accountId: string;
  transferAccountId: string | null;
  categoryId: string | null;
  amountMinor: number;
  currencyCode: string;
  description: string;
  interval: "weekly" | "monthly" | "quarterly" | "yearly";
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

/**
 * `createRecurring` and `updateRecurring` only ever write these three, but the
 * column reuses the shared transaction enum, so the row type is wider than the
 * form can represent. A row outside them could only come from a hand-written
 * insert; hide the edit affordance rather than let the form rewrite its type.
 */
const EDITABLE_TYPES = new Set(["income", "expense", "transfer"]);

function editableRecurring(row: RecurringRow) {
  return EDITABLE_TYPES.has(row.type)
    ? (row as RecurringRow & { type: "income" | "expense" | "transfer" })
    : null;
}

export function RecurringList({
  items,
  accounts,
  categories,
}: {
  items: RecurringRow[];
  accounts: Array<{ id: string; name: string }>;
  categories: CategoryOption[];
}) {
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
          const editable = editableRecurring(item);
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
              {editable && (
                <EditRecurringDialog
                  item={{
                    id: editable.id,
                    name: editable.name,
                    type: editable.type,
                    accountId: editable.accountId,
                    transferAccountId: editable.transferAccountId,
                    categoryId: editable.categoryId,
                    amountMinor: editable.amountMinor,
                    currencyCode: editable.currencyCode,
                    description: editable.description,
                    interval: editable.interval,
                    nextRunDate: editable.nextRunDate,
                  }}
                  accounts={accounts}
                  categories={categories}
                />
              )}
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
