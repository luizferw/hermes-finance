import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { formatDate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export interface InstallmentPlanRow {
  id: string;
  cardId: string;
  cardName: string;
  currencyCode: string;
  description: string;
  merchant: string | null;
  totalInstallments: number;
  paidInstallments: number;
  remainingCount: number;
  nextAmountMinor: number;
  nextExpectedAt: string | null;
  lastExpectedAt: string | null;
  remainingTotalMinor: number;
}

/**
 * Installments read like recurring transactions — a fixed amount every month
 * until a known end — so they are listed here rather than buried inside a card.
 *
 * Read-only on purpose. An installment is not a recurrence rule: it belongs to
 * the purchase that created it, the forecast already carries it through that
 * card's statement, and editing it here would be a second, conflicting source
 * of truth. The link goes back to where it can actually be changed.
 */
export function InstallmentList({ plans }: { plans: InstallmentPlanRow[] }) {
  if (plans.length === 0) return null;

  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">Installments</h3>
        <p className="text-xs text-muted-foreground">
          Card purchases still being paid off. Already counted in your forecast
          through each card&apos;s statement — shown here so you can see what
          they commit you to.
        </p>
      </div>
      <ul className="divide-y divide-dashed rounded-xl border bg-card px-4">
        {plans.map((plan) => (
          <li key={plan.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium">{plan.description}</p>
                <Badge variant="outline" className="text-[10px]">
                  {plan.paidInstallments + 1}/{plan.totalInstallments}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {plan.nextExpectedAt && `next ${formatDate(plan.nextExpectedAt)}`}
                {plan.lastExpectedAt && ` · last ${formatDate(plan.lastExpectedAt)}`}
                {` · ${formatMoney(plan.remainingTotalMinor, plan.currencyCode)} left`}
              </p>
            </div>
            <span className="font-amount text-sm tabular-nums">
              {formatMoney(plan.nextAmountMinor, plan.currencyCode)}
            </span>
            <Link
              href={`/plan/cards/${plan.cardId}`}
              className="group inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {plan.cardName}
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className="size-3.5 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover:translate-x-0.5"
                strokeWidth={2}
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
