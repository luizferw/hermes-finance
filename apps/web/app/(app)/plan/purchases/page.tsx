import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, ShoppingBag01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import { listAccounts } from "@/modules/accounts/queries";
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

export default async function PurchasesPage() {
  const user = await requireUser();
  const [plans, settings, accounts] = await Promise.all([
    listPurchasePlans(user.id),
    getUserSettings(user.id),
    listAccounts(user.id),
  ]);
  const accountOptions = accounts.map((account) => ({
    id: account.id,
    name: account.name,
    type: account.type,
  }));
  const accountById = new Map(accountOptions.map((account) => [account.id, account]));

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
                    See horizon impact
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
                  {plan.items.map((item) => {
                    const account = item.accountId ? accountById.get(item.accountId) : undefined;
                    return (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm">{item.name}</span>
                          {item.purchaseDate && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {formatDate(item.purchaseDate)}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                          {account && <Badge variant="outline" className="text-[10px]">{account.name}</Badge>}
                          {item.installments > 1 && <span>{item.installments}×</span>}
                          <span className="font-amount tabular-nums text-foreground">
                            {formatMoney(item.estimatedPriceMinor, plan.currencyCode)}
                          </span>
                          <PurchaseItemActions
                            item={{
                              id: item.id,
                              name: item.name,
                              estimatedPriceMinor: item.estimatedPriceMinor,
                              purchaseDate: item.purchaseDate,
                              accountId: item.accountId,
                              installments: item.installments,
                            }}
                            currencyCode={plan.currencyCode}
                            accounts={accountOptions}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
