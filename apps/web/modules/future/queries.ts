import "server-only";
import { daysBetween, todayIso } from "@kosh/domain";
import { listGoals } from "@/modules/goals/queries";
import { listRecurring } from "@/modules/recurring/queries";
import { listBills, type BillWithState } from "@/modules/bills/queries";
import { getUserSettings } from "@/modules/settings/queries";

/** Convert a recurrence interval to a per-month multiplier. */
const MONTHLY_FACTOR: Record<string, number> = {
  weekly: 52 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

const DAYS_PER_MONTH = 30.44;

export type GoalStatus = "achieved" | "on_pace" | "behind" | "open";

export interface GoalTrajectory {
  id: string;
  name: string;
  currencyCode: string;
  currentMinor: number;
  targetMinor: number;
  remainingMinor: number;
  /** 0–1 of target reached (clamped for display). */
  ratio: number;
  /** Expected fraction by now given the timeline, 0–1 (null when undated). */
  pace: number | null;
  targetDate: string | null;
  daysLeft: number | null;
  /** Contribution per month needed to land on the target date. */
  monthlyNeededMinor: number | null;
  status: GoalStatus;
  accountName: string | null;
}

export interface FutureView {
  goals: GoalTrajectory[];
  goalsRemainingMinor: number;
  goalsActive: number;
  /** Recurring + bills normalised to a monthly outflow. */
  committedMonthlyMinor: number;
  recurringMonthlyMinor: number;
  billsMonthlyMinor: number;
  committedCount: number;
  /** Bills due (or overdue) in the next ~6 weeks, soonest first. */
  upcomingBills: BillWithState[];
}

const STATUS_ORDER: Record<GoalStatus, number> = {
  behind: 0,
  on_pace: 1,
  open: 2,
  achieved: 3,
};

export async function getFutureView(userId: string): Promise<FutureView> {
  const [settings, goalRows, recurring, bills] = await Promise.all([
    getUserSettings(userId),
    listGoals(userId),
    listRecurring(userId),
    listBills(userId),
  ]);

  const today = todayIso();

  const goals: GoalTrajectory[] = goalRows.map((g) => {
    const ratio =
      g.targetAmountMinor > 0
        ? g.currentAmountMinor / g.targetAmountMinor
        : g.currentAmountMinor > 0
          ? 1
          : 0;
    const remaining = Math.max(0, g.targetAmountMinor - g.currentAmountMinor);
    const achieved = !!g.achievedAt || ratio >= 1;
    const daysLeft = g.targetDate ? daysBetween(today, g.targetDate) : null;
    const monthsLeft =
      daysLeft !== null ? Math.max(0, daysLeft / DAYS_PER_MONTH) : null;

    // Where the goal *should* be by now, on a straight line from creation to target.
    let pace: number | null = null;
    if (g.targetDate) {
      const start = g.createdAt.getTime();
      const end = new Date(g.targetDate).getTime();
      const now = Date.now();
      pace = end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
    }

    let status: GoalStatus;
    if (achieved) status = "achieved";
    else if (!g.targetDate) status = "open";
    else status = ratio >= (pace ?? 0) * 0.9 ? "on_pace" : "behind";

    const monthlyNeededMinor =
      achieved || monthsLeft === null
        ? null
        : Math.round(monthsLeft >= 1 ? remaining / monthsLeft : remaining);

    return {
      id: g.id,
      name: g.name,
      currencyCode: g.currencyCode,
      currentMinor: g.currentAmountMinor,
      targetMinor: g.targetAmountMinor,
      remainingMinor: remaining,
      ratio: Math.min(1, ratio),
      pace,
      targetDate: g.targetDate,
      daysLeft,
      monthlyNeededMinor,
      status,
      accountName: g.account?.name ?? null,
    };
  });

  goals.sort((a, b) => {
    if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status])
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    // Within a status, soonest deadline first; undated last.
    return (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity);
  });

  const recurringMonthlyMinor = Math.round(
    recurring
      .filter(
        (r) =>
          r.currencyCode === settings.currencyCode &&
          r.isActive &&
          r.type === "expense",
      )
      .reduce(
        (s, r) => s + Math.abs(r.amountMinor) * (MONTHLY_FACTOR[r.interval] ?? 1),
        0,
      ),
  );

  const activeBills = bills.filter(
    (b) => b.bill.isActive && b.bill.currencyCode === settings.currencyCode,
  );
  const allActiveBills = bills.filter((b) => b.bill.isActive);
  const billsMonthlyMinor = Math.round(
    activeBills.reduce(
      (s, b) =>
        s +
        Math.abs(b.bill.expectedAmountMinor) *
          (MONTHLY_FACTOR[b.bill.recurrence] ?? 1),
      0,
    ),
  );

  const upcomingBills = allActiveBills
    .filter((b) => b.state === "overdue" || b.daysUntilDue <= 45)
    .slice(0, 8);

  return {
    goals,
    goalsRemainingMinor: goals
      .filter(
        (g) =>
          g.currencyCode === settings.currencyCode && g.status !== "achieved",
      )
      .reduce((s, g) => s + g.remainingMinor, 0),
    goalsActive: goals.filter((g) => g.status !== "achieved").length,
    committedMonthlyMinor: recurringMonthlyMinor + billsMonthlyMinor,
    recurringMonthlyMinor,
    billsMonthlyMinor,
    committedCount:
      recurring.filter(
        (r) =>
          r.isActive &&
          r.type === "expense" &&
          r.currencyCode === settings.currencyCode,
      ).length + activeBills.length,
    upcomingBills,
  };
}
