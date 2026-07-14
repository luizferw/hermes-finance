import "server-only";
import { eq } from "drizzle-orm";
import { budgetPeriods, budgets, db } from "@kosh/db";
import { monthRange, todayIso } from "@kosh/domain";

/**
 * Job helper (not a server action): ensure every active budget has a period
 * for the current month, copying the latest planned amount forward.
 */
export async function ensureCurrentBudgetPeriods(): Promise<number> {
  const { start, end } = monthRange(todayIso());
  const all = await db.query.budgets.findMany({
    where: eq(budgets.isArchived, false),
    with: { periods: true },
  });
  let created = 0;
  for (const budget of all) {
    const hasCurrent = budget.periods.some((p) => p.periodStart === start);
    if (hasCurrent) continue;
    const latest = [...budget.periods].sort((a, b) =>
      a.periodStart < b.periodStart ? 1 : -1,
    )[0];
    if (!latest) continue;
    await db.insert(budgetPeriods).values({
      budgetId: budget.id,
      periodStart: start,
      periodEnd: end,
      plannedAmountMinor: latest.plannedAmountMinor,
      currencyCode: latest.currencyCode,
    });
    created += 1;
  }
  return created;
}
