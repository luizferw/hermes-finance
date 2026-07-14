import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { PieChart01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listBudgetsWithProgress } from "@/modules/budgets/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import { formatAbsAmount } from "@/lib/format";
import { formatMoney } from "@kosh/domain";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { CategoryBadge } from "@/components/transactions/category-badge";
import { NewBudgetDialog } from "./new-budget-dialog";

export const metadata: Metadata = { title: "Budgets" };

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const [budgets, categories] = await Promise.all([
    listBudgetsWithProgress(user.id),
    listCategories(user.id),
  ]);

  const totalPlanned = budgets.reduce((acc, b) => acc + b.plannedMinor, 0);
  const totalSpent = budgets.reduce((acc, b) => acc + b.spentMinor, 0);
  const currency = budgets[0]?.currencyCode ?? "INR";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">This month</h2>
          {budgets.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <span className="font-amount">
                {formatMoney(totalSpent, currency)}
              </span>{" "}
              spent of{" "}
              <span className="font-amount">
                {formatMoney(totalPlanned, currency)}
              </span>{" "}
              planned
            </p>
          )}
        </div>
        <NewBudgetDialog
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            color: c.color,
          }))}
          defaultOpen={params.new === "1"}
        />
      </div>

      {budgets.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={PieChart01Icon} />
            </EmptyMedia>
            <EmptyTitle>No budgets yet</EmptyTitle>
            <EmptyDescription>
              A budget is an envelope: pick categories, set a monthly amount,
              and Kosh tracks the rest. Start with groceries or eating out.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
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
              <div className="flex flex-wrap gap-1.5">
                {budget.categories.map((category) => (
                  <CategoryBadge
                    key={category.id}
                    category={category}
                    className="px-1.5 py-0 text-[10px]"
                  />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
