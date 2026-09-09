import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, ShoppingBag01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import { listPurchasePlans } from "@/modules/finance/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { PurchaseItemActions } from "./item-actions";
import { NewPurchasePlanDialog } from "./new-plan-dialog";
import { PurchasePlanActions } from "./plan-actions";
import { PlanTotalsLine } from "./plan-totals";

export const metadata: Metadata = { title: "Purchases" };

const PLAN_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

const PRIORITY_LABEL: Record<string, string> = {
  must_have: "Must have",
  high: "High",
  medium: "Medium",
  low: "Low",
  optional: "Optional",
};

const ITEM_STATUS_LABEL: Record<string, string> = {
  idea: "Idea",
  planned: "Planned",
  ready: "Ready",
  purchased: "Purchased",
  cancelled: "Cancelled",
};

export default async function PurchasesPage() {
  const user = await requireUser();
  const [plans, settings] = await Promise.all([
    listPurchasePlans(user.id),
    getUserSettings(user.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Purchase plans</h2>
          <p className="text-sm text-muted-foreground">
            What you&apos;re planning to buy, and how it would fit against your money.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NewPurchasePlanDialog defaultCurrency={settings.currencyCode} />
        </div>
      </div>

      {plans.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={ShoppingBag01Icon} />
            </EmptyMedia>
            <EmptyTitle>Nothing planned yet</EmptyTitle>
            <EmptyDescription>
              Group the things you&apos;re considering buying into a plan to compare how each would land on your cash.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-6">
          {plans.map((plan) => (
            <li key={plan.id} className="rounded-xl border border-border/60 bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{plan.name}</p>
                  {plan.description && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{plan.description}</p>
                  )}
                  <PlanTotalsLine
                    className="mt-1"
                    totals={{
                      estimatedTotalMinor: plan.estimatedTotalMinor,
                      remainingEstimateMinor: plan.remainingEstimateMinor,
                      purchasedTotalMinor: plan.purchasedTotalMinor,
                      overBudgetMinor: plan.overBudgetMinor,
                      underBudgetMinor: plan.underBudgetMinor,
                      budgetMinor: plan.budgetMinor,
                      currencyCode: plan.currencyCode,
                    }}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <Badge variant="outline" className="text-[10px]">
                    {PLAN_STATUS_LABEL[plan.status] ?? plan.status}
                  </Badge>
                  {plan.targetDate && (
                    <span className="text-xs text-muted-foreground">
                      Target {formatDate(plan.targetDate)}
                    </span>
                  )}
                  <Link
                    href={`/plan/purchases/${plan.id}`}
                    className="group inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Compare payment options
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className="size-3.5 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover:translate-x-0.5"
                      strokeWidth={2}
                    />
                  </Link>
                  <PurchasePlanActions
                    plan={{
                      id: plan.id,
                      name: plan.name,
                      description: plan.description,
                      targetDate: plan.targetDate,
                      budgetMinor: plan.budgetMinor,
                      currencyCode: plan.currencyCode,
                      status: plan.status,
                    }}
                  />
                </div>
              </div>

              {plan.items.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">No items in this plan yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-dashed">
                  {plan.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            item.priority === "must_have"
                              ? "bg-destructive"
                              : item.priority === "high"
                                ? "bg-warning"
                                : "bg-muted-foreground/40",
                          )}
                          aria-hidden
                        />
                        <span className="truncate text-sm">{item.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {PRIORITY_LABEL[item.priority] ?? item.priority}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-[10px]">
                          {ITEM_STATUS_LABEL[item.status] ?? item.status}
                        </Badge>
                        {item.deadline && <span>by {formatDate(item.deadline)}</span>}
                        <span className="font-amount tabular-nums text-foreground">
                          {formatMoney(
                            item.actualPriceMinor ?? item.estimatedPriceMinor,
                            plan.currencyCode,
                          )}
                        </span>
                        <PurchaseItemActions
                          item={{
                            id: item.id,
                            name: item.name,
                            priority: item.priority,
                            estimatedPriceMinor: item.estimatedPriceMinor,
                            actualPriceMinor: item.actualPriceMinor,
                            earliestPurchaseDate: item.earliestPurchaseDate,
                            deadline: item.deadline,
                            status: item.status,
                            notes: item.notes,
                            maxInstallments: item.maxInstallments,
                          }}
                          currencyCode={plan.currencyCode}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
