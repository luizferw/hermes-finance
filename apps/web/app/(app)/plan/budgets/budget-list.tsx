"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Archive01Icon } from "@hugeicons/core-free-icons";
import { minorToMajor } from "@kosh/domain";
import { archiveBudget } from "@/modules/budgets/mutations";
import { formatAbsAmount } from "@/lib/format";
import type { CategoryOption } from "@/components/transactions/category-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { CategoryBadge } from "@/components/transactions/category-badge";
import { EditBudgetDialog } from "./edit-budget-dialog";

export interface BudgetRow {
  id: string;
  name: string;
  plannedMinor: number;
  spentMinor: number;
  remainingMinor: number;
  ratio: number;
  isOver: boolean;
  isNearLimit: boolean;
  currencyCode: string;
  hasPeriod: boolean;
  categories: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Renders the month's budget cards with edit/archive controls. Archiving is
 * immediate — `listBudgetsWithProgress` already excludes archived budgets,
 * so there is nothing to undo from here once it succeeds.
 */
export function BudgetList({
  budgets,
  categories,
}: {
  budgets: BudgetRow[];
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function archive(budget: BudgetRow) {
    setBusyId(budget.id);
    startTransition(async () => {
      try {
        await archiveBudget(budget.id);
        toast.success(`${budget.name} archived`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not archive the budget");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {budgets.map((budget) => (
        <Card key={budget.id} className="gap-3 px-5 py-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-medium">{budget.name}</p>
            <p
              className={
                budget.isOver
                  ? "font-amount text-sm text-destructive"
                  : "font-amount text-sm text-muted-foreground"
              }
            >
              {budget.isOver
                ? `${formatAbsAmount(-budget.remainingMinor, budget.currencyCode)} over`
                : `${formatAbsAmount(budget.remainingMinor, budget.currencyCode)} left`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Progress
              value={Math.min(100, budget.ratio * 100)}
              className={
                budget.isOver
                  ? "[&>[data-slot=progress-indicator]]:bg-destructive"
                  : budget.isNearLimit
                    ? "[&>[data-slot=progress-indicator]]:bg-warning"
                    : ""
              }
            />
            <p className="font-amount text-xs text-muted-foreground">
              {formatAbsAmount(budget.spentMinor, budget.currencyCode)} /{" "}
              {formatAbsAmount(budget.plannedMinor, budget.currencyCode)}
              {!budget.hasPeriod && " · no plan set this month"}
            </p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {budget.categories.map((category) => (
                <CategoryBadge
                  key={category.id}
                  category={category}
                  className="px-1.5 py-0 text-[10px]"
                />
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <EditBudgetDialog
                budget={{
                  id: budget.id,
                  name: budget.name,
                  plannedAmount: minorToMajor(budget.plannedMinor, budget.currencyCode),
                  categoryIds: budget.categories.map((category) => category.id),
                }}
                categories={categories}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={isPending && busyId === budget.id}
                onClick={() => archive(budget)}
                aria-label={`Archive ${budget.name}`}
              >
                <HugeiconsIcon icon={Archive01Icon} className="size-4 text-muted-foreground" />
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
