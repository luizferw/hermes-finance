import "server-only";
import { and, asc, eq, gte } from "drizzle-orm";
import { confidenceSnapshots, db } from "@kosh/db";
import {
  computeConfidence,
  todayIso,
  type ConfidenceResult,
} from "@kosh/domain";
import { listAccounts } from "@/modules/accounts/queries";
import {
  getMonthlyFlows,
  getMonthSummary,
} from "@/modules/reports/queries";
import { listBudgetsWithProgress } from "@/modules/budgets/queries";
import { getUpcomingBills } from "@/modules/bills/queries";
import { listGoals } from "@/modules/goals/queries";
import { getInboxCount } from "@/modules/transactions/queries";
import { getUserSettings } from "@/modules/settings/queries";

/** Account types that count as liquid for runway (excludes investments & debts). */
const LIQUID_TYPES = new Set(["cash", "wallet", "asset"]);

export interface ConfidenceView extends ConfidenceResult {
  /** Score change vs. ~7 days ago, or null when there's no prior reading. */
  weekDelta: number | null;
  /** Consecutive days (incl. today) the user stayed on top. */
  streakDays: number;
  /** Last ~30 days of scores for the trend line, oldest first. */
  trend: Array<{ date: string; score: number }>;
}

/** Is a goal on or ahead of pace? Achieved counts; undated goals just need progress. */
function goalOnTrack(g: {
  currentAmountMinor: number;
  targetAmountMinor: number;
  targetDate: string | null;
  achievedAt: string | null;
  createdAt: Date;
}): boolean {
  if (g.achievedAt) return true;
  if (g.targetAmountMinor <= 0) return true;
  const progress = g.currentAmountMinor / g.targetAmountMinor;
  if (!g.targetDate) return progress > 0;
  const start = g.createdAt.getTime();
  const end = new Date(g.targetDate).getTime();
  const now = Date.now();
  if (end <= start) return progress >= 1;
  const expected = Math.min(1, Math.max(0, (now - start) / (end - start)));
  // 10% slack so a goal a hair behind pace still reads as on track.
  return progress >= expected * 0.9;
}

export async function getConfidence(userId: string): Promise<ConfidenceView> {
  const [settings, accounts, flows, month, budgets, bills, goals, inboxCount] =
    await Promise.all([
      getUserSettings(userId),
      listAccounts(userId),
      getMonthlyFlows(userId, 6),
      getMonthSummary(userId),
      listBudgetsWithProgress(userId),
      getUpcomingBills(userId, 14),
      listGoals(userId),
      getInboxCount(userId),
    ]);

  const liquidAssetsMinor = accounts
    .filter(
      (a) =>
        a.currencyCode === settings.currencyCode &&
        !a.isArchived &&
        LIQUID_TYPES.has(a.type) &&
        a.currentBalanceMinor > 0,
    )
    .reduce((s, a) => s + a.currentBalanceMinor, 0);

  // Trailing average spend over completed months (drop the current partial month).
  const past = flows.slice(0, -1);
  const avgMonthlySpendMinor =
    past.length > 0
      ? Math.round(past.reduce((s, f) => s + f.expenseMinor, 0) / past.length)
      : month.expenseMinor;

  const currencyBills = bills.filter(
    (b) => b.bill.currencyCode === settings.currencyCode,
  );
  const overdue = currencyBills.filter((b) => b.state === "overdue");
  const upcomingBillsTotalMinor = currencyBills.reduce(
    (s, b) => s + Math.abs(b.bill.expectedAmountMinor),
    0,
  );

  const result = computeConfidence({
    liquidAssetsMinor,
    avgMonthlySpendMinor,
    incomeThisMonthMinor: month.incomeMinor,
    expenseThisMonthMinor: month.expenseMinor,
    budgetsTotal: budgets.filter((b) => b.hasPeriod).length,
    budgetsOver: budgets.filter((b) => b.isOver).length,
    upcomingBillsTotalMinor,
    billsOverdue: overdue.length,
    goalsTotal: goals.length,
    goalsOnTrack: goals.filter(goalOnTrack).length,
    inboxCount,
  });

  const today = todayIso();

  // snapshot is written on render. Single-user self-hosted app, the
  // upsert is idempotent and cheap, so a side-effect on GET is the pragmatic
  // call. Move to the nightly job if multi-user/perf ever matters.
  await db
    .insert(confidenceSnapshots)
    .values({
      userId,
      date: today,
      score: result.score,
      band: result.band,
      onTop: result.onTop,
      factors: result.factors.map((f) => ({
        key: f.key,
        score: f.score,
        status: f.status,
      })),
    })
    .onConflictDoUpdate({
      target: [confidenceSnapshots.userId, confidenceSnapshots.date],
      set: { score: result.score, band: result.band, onTop: result.onTop },
    });

  // Last 30 days of history for trend, week-delta and streak.
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString().slice(0, 10);
  const history = await db.query.confidenceSnapshots.findMany({
    where: and(
      eq(confidenceSnapshots.userId, userId),
      gte(confidenceSnapshots.date, sinceIso),
    ),
    columns: { date: true, score: true, onTop: true },
    orderBy: [asc(confidenceSnapshots.date)],
  });

  const trend = history.map((h) => ({ date: h.date, score: h.score }));

  // Week delta: compare against the latest reading at least 7 days old.
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoIso = weekAgo.toISOString().slice(0, 10);
  const prior = [...history].reverse().find((h) => h.date <= weekAgoIso);
  const weekDelta = prior ? result.score - prior.score : null;

  // Streak: walk back from today over consecutive on-top days.
  const onTopDates = new Set(history.filter((h) => h.onTop).map((h) => h.date));
  let streakDays = 0;
  const cursor = new Date();
  while (onTopDates.has(cursor.toISOString().slice(0, 10))) {
    streakDays++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { ...result, weekDelta, streakDays, trend };
}
