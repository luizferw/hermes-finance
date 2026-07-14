/** Budget math. Spending is positive here (absolute outflow). */

export interface BudgetProgress {
  plannedMinor: number;
  spentMinor: number;
  remainingMinor: number;
  /** 0..1+, where > 1 means over budget. */
  ratio: number;
  isOver: boolean;
  /** Within 10% of the limit but not over. */
  isNearLimit: boolean;
}

export function budgetProgress(
  plannedMinor: number,
  spentMinor: number,
): BudgetProgress {
  const spent = Math.max(0, spentMinor);
  const remainingMinor = plannedMinor - spent;
  const ratio = plannedMinor > 0 ? spent / plannedMinor : spent > 0 ? Infinity : 0;
  return {
    plannedMinor,
    spentMinor: spent,
    remainingMinor,
    ratio,
    isOver: remainingMinor < 0,
    isNearLimit: remainingMinor >= 0 && plannedMinor > 0 && ratio >= 0.9,
  };
}

/**
 * Sum spending (absolute value of negative amounts) for transactions whose
 * category belongs to the budget, inside the period window.
 */
export function spentInPeriod(
  transactions: Array<{
    amountMinor: number;
    date: string;
    categoryId: string | null;
    status: string;
    type: string;
    currencyCode?: string;
  }>,
  categoryIds: Set<string>,
  periodStart: string,
  periodEnd: string,
  currencyCode?: string,
): number {
  let total = 0;
  for (const tx of transactions) {
    if (tx.type !== "expense") continue;
    if (currencyCode && tx.currencyCode !== currencyCode) continue;
    if (!["imported", "reviewed", "posted"].includes(tx.status)) continue;
    if (!tx.categoryId || !categoryIds.has(tx.categoryId)) continue;
    if (tx.date < periodStart || tx.date > periodEnd) continue;
    if (tx.amountMinor < 0) total += -tx.amountMinor;
  }
  return total;
}
