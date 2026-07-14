import "server-only";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { budgetPeriods, budgets, db, transactions } from "@kosh/db";
import { budgetProgress, monthRange, spentInPeriod, todayIso } from "@kosh/domain";
import { getUserSettings } from "@/modules/settings/queries";

export interface BudgetWithProgress {
  id: string;
  name: string;
  color: string | null;
  plannedMinor: number;
  spentMinor: number;
  remainingMinor: number;
  ratio: number;
  isOver: boolean;
  isNearLimit: boolean;
  currencyCode: string;
  categories: Array<{ id: string; name: string; color: string | null }>;
  periodStart: string;
  periodEnd: string;
  hasPeriod: boolean;
}

/** Budgets with progress for the month containing `monthIso` (default: now). */
export async function listBudgetsWithProgress(
  userId: string,
  monthIso = todayIso(),
): Promise<BudgetWithProgress[]> {
  const { start, end } = monthRange(monthIso);

  const [{ currencyCode: defaultCurrency }, budgetRows] = await Promise.all([
    getUserSettings(userId),
    db.query.budgets.findMany({
      where: and(eq(budgets.userId, userId), eq(budgets.isArchived, false)),
      with: {
        budgetCategories: { with: { category: true } },
        periods: {
          where: and(
            gte(budgetPeriods.periodStart, start),
            lte(budgetPeriods.periodStart, end),
          ),
        },
      },
      orderBy: [asc(budgets.name)],
    }),
  ]);

  const allCategoryIds = budgetRows.flatMap((b) =>
    b.budgetCategories.map((bc) => bc.categoryId),
  );
  const spendRows =
    allCategoryIds.length === 0
      ? []
      : await db.query.transactions.findMany({
          where: and(
            eq(transactions.userId, userId),
            gte(transactions.date, start),
            lte(transactions.date, end),
            inArray(transactions.categoryId, allCategoryIds),
          ),
          columns: {
            amountMinor: true,
            date: true,
            categoryId: true,
            status: true,
            type: true,
            currencyCode: true,
          },
        });

  return budgetRows.map((budget) => {
    const period = budget.periods[0];
    const categoryIds = new Set(budget.budgetCategories.map((bc) => bc.categoryId));
    const spent = period
      ? spentInPeriod(
          spendRows,
          categoryIds,
          start,
          end,
          period.currencyCode,
        )
      : 0;
    const planned = period?.plannedAmountMinor ?? 0;
    const progress = budgetProgress(planned, spent);
    return {
      id: budget.id,
      name: budget.name,
      color: budget.color,
      ...progress,
      plannedMinor: planned,
      currencyCode: period?.currencyCode ?? defaultCurrency,
      categories: budget.budgetCategories.map((bc) => ({
        id: bc.category.id,
        name: bc.category.name,
        color: bc.category.color,
      })),
      periodStart: start,
      periodEnd: end,
      hasPeriod: !!period,
    };
  });
}

/** Past N months of planned vs spent for one budget (reports). */
export async function getBudgetHistory(userId: string, months = 6) {
  const results: Array<{
    month: string;
    budgets: BudgetWithProgress[];
  }> = [];
  const today = todayIso();
  for (let m = months - 1; m >= 0; m--) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - m);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
    if (iso > today) continue;
    results.push({
      month: iso.slice(0, 7),
      budgets: await listBudgetsWithProgress(userId, iso),
    });
  }
  return results;
}

export async function getBudget(userId: string, id: string) {
  return db.query.budgets.findFirst({
    where: and(eq(budgets.id, id), eq(budgets.userId, userId)),
    with: {
      budgetCategories: { with: { category: true } },
      periods: { orderBy: [asc(budgetPeriods.periodStart)] },
    },
  });
}
