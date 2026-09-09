import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { PieChart01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listArchivedBudgets, listBudgetsWithProgress } from "@/modules/budgets/queries";
import { restoreBudget } from "@/modules/budgets/mutations";
import { listCategories } from "@/modules/taxonomy/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { formatMoney } from "@/lib/format";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ArchivedList } from "@/components/shared/archived-list";
import { BudgetList } from "./budget-list";
import { NewBudgetDialog } from "./new-budget-dialog";

export const metadata: Metadata = { title: "Budgets" };

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const [budgets, categories, settings, archivedBudgets] = await Promise.all([
    listBudgetsWithProgress(user.id),
    listCategories(user.id),
    getUserSettings(user.id),
    listArchivedBudgets(user.id),
  ]);

  const totalPlanned = budgets.reduce((acc, b) => acc + b.plannedMinor, 0);
  const totalSpent = budgets.reduce((acc, b) => acc + b.spentMinor, 0);
  const currency = budgets[0]?.currencyCode ?? settings.currencyCode;
  const categoryOptions = categories.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
  }));

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
          categories={categoryOptions}
          defaultCurrency={settings.currencyCode}
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
        <BudgetList budgets={budgets} categories={categoryOptions} />
      )}

      <ArchivedList
        rows={archivedBudgets.map((budget) => ({ id: budget.id, name: budget.name }))}
        label="budgets"
        restore={restoreBudget}
      />
    </div>
  );
}
