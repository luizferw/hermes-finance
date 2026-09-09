import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface PlanTotals {
  estimatedTotalMinor: number;
  remainingEstimateMinor: number;
  purchasedTotalMinor: number;
  overBudgetMinor: number | null;
  underBudgetMinor: number | null;
  budgetMinor: number | null;
  currencyCode: string;
}

/**
 * What the plan costs, against what it was allowed to cost.
 *
 * A list of item prices is not an answer — the question a purchase plan exists
 * to settle is whether the whole thing fits. Every figure here is summed in the
 * query layer; this only formats them.
 */
export function PlanTotalsLine({ totals, className }: { totals: PlanTotals; className?: string }) {
  const { currencyCode } = totals;
  const over = totals.overBudgetMinor !== null && totals.overBudgetMinor > 0;

  return (
    <p className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs", className)}>
      <span className="font-amount tabular-nums text-foreground">
        {formatMoney(totals.estimatedTotalMinor, currencyCode)}
      </span>
      <span className="text-muted-foreground">estimated</span>

      {totals.budgetMinor !== null && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground">
            budget{" "}
            <span className="font-amount tabular-nums">
              {formatMoney(totals.budgetMinor, currencyCode)}
            </span>
          </span>
          <span
            className={cn(
              "font-medium",
              over ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {over
              ? `${formatMoney(totals.overBudgetMinor!, currencyCode)} over`
              : `${formatMoney(totals.underBudgetMinor!, currencyCode)} left`}
          </span>
        </>
      )}

      {totals.purchasedTotalMinor > 0 && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground">
            <span className="font-amount tabular-nums">
              {formatMoney(totals.remainingEstimateMinor, currencyCode)}
            </span>{" "}
            still to buy
          </span>
        </>
      )}
    </p>
  );
}
