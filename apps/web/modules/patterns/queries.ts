import "server-only";
import { addMonthsClamped, todayIso } from "@kosh/domain";
import {
  getMonthlyFlows,
  getSpendingByCategory,
} from "@/modules/reports/queries";

export interface CategoryDrift {
  key: string;
  name: string;
  color: string | null;
  currentMinor: number;
  priorMinor: number;
  deltaMinor: number;
  /** Percent change vs prior month; null when there was no prior spend. */
  deltaPct: number | null;
  /** True when the category is new this month (no prior spend). */
  isNew: boolean;
}

export interface PatternsView {
  drift: CategoryDrift[];
  thisMonthSpendMinor: number;
  lastMonthSpendMinor: number;
  /** Net-positive months out of the trailing window. */
  keptMonths: number;
  ofMonths: number;
  /** Average savings rate across months that had income, 0–100. */
  avgSavingsRatePct: number;
  topCategory: { name: string; pct: number } | null;
}

export async function getPatternsView(userId: string): Promise<PatternsView> {
  const lastMonthIso = addMonthsClamped(todayIso(), -1);
  const [current, prior, flows] = await Promise.all([
    getSpendingByCategory(userId),
    getSpendingByCategory(userId, lastMonthIso),
    getMonthlyFlows(userId, 6),
  ]);

  const priorByKey = new Map(
    prior.map((c) => [c.categoryId ?? c.name, c]),
  );
  const seen = new Set<string>();
  const drift: CategoryDrift[] = current.map((c) => {
    const key = c.categoryId ?? c.name;
    seen.add(key);
    const p = priorByKey.get(key);
    const priorMinor = p?.spentMinor ?? 0;
    const deltaMinor = c.spentMinor - priorMinor;
    return {
      key,
      name: c.name,
      color: c.color,
      currentMinor: c.spentMinor,
      priorMinor,
      deltaMinor,
      deltaPct: priorMinor > 0 ? Math.round((deltaMinor / priorMinor) * 100) : null,
      isNew: priorMinor === 0,
    };
  });
  // Categories that vanished this month (spent last month, nothing now).
  for (const p of prior) {
    const key = p.categoryId ?? p.name;
    if (seen.has(key)) continue;
    drift.push({
      key,
      name: p.name,
      color: p.color,
      currentMinor: 0,
      priorMinor: p.spentMinor,
      deltaMinor: -p.spentMinor,
      deltaPct: -100,
      isNew: false,
    });
  }
  drift.sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor));

  const thisMonthSpendMinor = current.reduce((s, c) => s + c.spentMinor, 0);
  const lastMonthSpendMinor = prior.reduce((s, c) => s + c.spentMinor, 0);

  const keptMonths = flows.filter((f) => f.netMinor >= 0).length;
  const withIncome = flows.filter((f) => f.incomeMinor > 0);
  const avgSavingsRatePct =
    withIncome.length > 0
      ? Math.round(
          (withIncome.reduce((s, f) => s + f.netMinor / f.incomeMinor, 0) /
            withIncome.length) *
            100,
        )
      : 0;

  const top = [...current].sort((a, b) => b.spentMinor - a.spentMinor)[0];
  const topCategory =
    top && thisMonthSpendMinor > 0
      ? { name: top.name, pct: Math.round((top.spentMinor / thisMonthSpendMinor) * 100) }
      : null;

  return {
    drift,
    thisMonthSpendMinor,
    lastMonthSpendMinor,
    keptMonths,
    ofMonths: flows.length,
    avgSavingsRatePct,
    topCategory,
  };
}
