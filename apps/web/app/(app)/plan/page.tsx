import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Target01Icon,
} from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { formatDate, formatMoney, formatRelativeDays } from "@/lib/format";
import { getUserSettings } from "@/modules/settings/queries";
import {
  buildUserForecastDetailed,
  getConfidenceBreakdown,
  getFinancePosition,
  getSafeToSpend,
} from "@/modules/finance/queries";
import {
  getFutureView,
  type FutureView,
  type GoalTrajectory,
} from "@/modules/future/queries";
import { FinancialPositionSummary } from "@/components/plan/financial-position";
import { ConfidenceBreakdownMeter } from "@/components/plan/confidence-breakdown";
import { ForecastHorizonChart, type HorizonSeries } from "@/components/plan/forecast-horizon-chart";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Future" };

/** The horizons the forecast chart lets you switch between. */
const CHART_HORIZONS: Array<{ days: number; label: string }> = [
  { days: 30, label: "30d" },
  { days: 60, label: "60d" },
  { days: 90, label: "90d" },
  { days: 180, label: "6m" },
  { days: 365, label: "12m" },
];

export default async function FuturePage() {
  const user = await requireUser();
  const [settings, future, position, safeToSpend, confidence, horizonForecasts] =
    await Promise.all([
      getUserSettings(user.id),
      getFutureView(user.id),
      getFinancePosition(user.id),
      getSafeToSpend(user.id, 30),
      getConfidenceBreakdown(user.id, 90),
      Promise.all(CHART_HORIZONS.map((h) => buildUserForecastDetailed(user.id, h.days))),
    ]);
  const currency = settings.currencyCode;

  // Each horizon is its own engine run — the chart only ever switches
  // between fully precomputed series, never recomputes one client-side.
  const chartSeries: HorizonSeries[] = horizonForecasts.map(({ forecast }, i) => ({
    horizonDays: CHART_HORIZONS[i]!.days,
    label: CHART_HORIZONS[i]!.label,
    data: forecast.days.map((day) => ({
      date: day.date,
      closingBalanceMinor: day.closingBalanceMinor,
    })),
    openingBalanceMinor: forecast.openingBalanceMinor,
    minimumBalanceMinor: forecast.minimumBalanceMinor,
    minimumBalanceDate: forecast.minimumBalanceDate,
  }));

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-10 py-2 md:space-y-14 md:py-4">
      {/* ── Movement 0 · Financial position ───────────────────────────── */}
      <section className="row-in" style={{ "--i": 0 } as React.CSSProperties} aria-label="Your financial position">
        <FinancialPositionSummary
          position={position}
          safeToSpendMinor={safeToSpend.safeToSpendMinor}
          committedMinor={safeToSpend.committedMinor}
          hardReserveMinor={safeToSpend.hardReserveMinor}
          currency={currency}
        />
      </section>

      <section className="row-in" style={{ "--i": 1 } as React.CSSProperties} aria-label="Balance forecast">
        <ForecastHorizonChart series={chartSeries} currency={currency} />
      </section>

      <section className="row-in" style={{ "--i": 2 } as React.CSSProperties} aria-label="How the forecast is made up">
        <span className="micro-label">Confidence in this forecast</span>
        <ConfidenceBreakdownMeter breakdown={confidence} />
      </section>

      <hr className="border-border/60" />

      {/* ── Movement I · The horizon ──────────────────────────────────── */}
      <section
        className="row-in"
        style={{ "--i": 0 } as React.CSSProperties}
        aria-label="Where you're headed"
      >
        <Horizon future={future} currency={currency} />
      </section>

      {/* ── Movement II · Goal trajectories ───────────────────────────── */}
      <section
        className="row-in"
        style={{ "--i": 1 } as React.CSSProperties}
        aria-label="Your goals"
      >
        <h2 className="micro-label">Your goals</h2>
        {future.goals.length > 0 ? (
          <ul className="mt-5 space-y-7">
            {future.goals.map((g, i) => (
              <Trajectory key={g.id} goal={g} index={i} />
            ))}
          </ul>
        ) : (
          <Empty
            icon
            title="No goals yet"
            body="Name something you're saving toward and watch the path to it take shape."
            href="/plan/goals"
            cta="Set a goal"
          />
        )}
      </section>

      <hr className="border-border/60" />

      {/* ── Movement III · What's committed ────────────────────────────── */}
      <section
        className="row-in grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <div className="min-w-0">
          <h2 className="micro-label">Committed each month</h2>
          <Committed future={future} currency={currency} />
        </div>
        <div className="min-w-0 lg:border-l lg:border-border/60 lg:pl-12">
          <div className="flex items-center justify-between gap-3">
            <h2 className="micro-label">Coming up</h2>
            <Link
              href="/plan/bills"
              className="group inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Bills
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className="size-3.5 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover:translate-x-0.5"
                strokeWidth={2}
              />
            </Link>
          </div>
          {future.upcomingBills.length > 0 ? (
            <Agenda future={future} />
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
              Nothing due in the next six weeks.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/* ──────────────────────────── The horizon ───────────────────────────── */

/**
 * The standing for the future: a plain-language lead, then three figures held
 * as one relationship — how many goals are in motion, what's still to save, and
 * what each month is already committed to. Figures carry the weight; no cards.
 */
function Horizon({ future, currency }: { future: FutureView; currency: string }) {
  const lead =
    future.goalsActive > 0
      ? `You're saving toward ${future.goalsActive} ${future.goalsActive === 1 ? "goal" : "goals"}.`
      : future.committedMonthlyMinor > 0
        ? "Your month ahead is mapped out."
        : "Nothing on the horizon yet.";

  return (
    <div>
      <span className="micro-label">Where you&apos;re headed</span>
      <p className="mt-2 max-w-[20ch] text-[clamp(1.75rem,3.6vw,2.5rem)] leading-[1.05] font-medium tracking-[-0.02em] text-balance text-foreground">
        {lead}
      </p>
      <dl className="mt-7 grid max-w-2xl grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3">
        <Figure label="In motion" value={String(future.goalsActive)} unit="goals" />
        <Figure
          label="Still to save"
          value={formatMoney(future.goalsRemainingMinor, currency)}
        />
        <Figure
          label="Committed monthly"
          value={formatMoney(future.committedMonthlyMinor, currency)}
          note={`${future.committedCount} recurring + bills`}
        />
      </dl>
    </div>
  );
}

function Figure({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="micro-label">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-1.5">
        <span className="truncate font-amount text-2xl font-medium tracking-tight text-foreground tabular-nums">
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </dd>
      {note && <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{note}</p>}
    </div>
  );
}

/* ────────────────────────── Goal trajectory ─────────────────────────── */

/**
 * A goal as a path, not a card. The fern fill is progress; a hairline pace
 * marker shows where the goal *should* be by now, so being ahead or behind is
 * visible at a glance before any number is read. The line beneath says, in
 * words, what it would take to land on time.
 */
function Trajectory({ goal, index }: { goal: GoalTrajectory; index: number }) {
  const achieved = goal.status === "achieved";
  const behind = goal.status === "behind";
  const pct = Math.round(goal.ratio * 100);
  const behindMinor =
    behind && goal.pace !== null
      ? Math.max(0, Math.round((goal.pace - goal.ratio) * goal.targetMinor))
      : 0;

  return (
    <li>
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="truncate text-[0.9375rem] font-medium text-foreground">
            {goal.name}
          </span>
          {goal.accountName && (
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              {goal.accountName}
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="font-amount text-sm tabular-nums">
            {formatMoney(goal.currentMinor, goal.currencyCode)}
          </span>
          <span className="font-amount text-xs text-muted-foreground/70 tabular-nums">
            / {formatMoney(goal.targetMinor, goal.currencyCode)}
          </span>
        </span>
      </div>

      {/* The path. */}
      <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
        <span
          className={cn(
            "grow-x block h-full rounded-full",
            achieved ? "bg-success" : "bg-primary",
          )}
          style={
            {
              width: `${Math.max(2, goal.ratio * 100)}%`,
              "--i": index,
            } as React.CSSProperties
          }
        />
        {/* Pace marker — where you should be by now. */}
        {goal.pace !== null && !achieved && goal.pace > 0.02 && goal.pace < 0.99 && (
          <span
            aria-hidden
            title="Where you should be by now"
            className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-foreground/45"
            style={{ left: `${goal.pace * 100}%` }}
          />
        )}
      </div>

      {/* The plain read. */}
      <p
        className={cn(
          "mt-2 text-xs",
          behind ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {achieved ? (
          <span className="font-medium text-success">
            Reached
            {goal.targetDate ? ` · ${formatDate(goal.targetDate)}` : ""}
          </span>
        ) : goal.status === "open" ? (
          <>
            <Money value={formatMoney(goal.remainingMinor, goal.currencyCode)} /> to
            go · {pct}% there
          </>
        ) : behind ? (
          <>
            <Money value={formatMoney(behindMinor, goal.currencyCode)} /> behind pace
            {goal.monthlyNeededMinor !== null && (
              <>
                {" · "}
                <Money
                  value={formatMoney(goal.monthlyNeededMinor, goal.currencyCode)}
                />
                /mo to catch up
              </>
            )}
            {goal.daysLeft !== null && ` · target ${formatRelativeDays(goal.daysLeft)}`}
          </>
        ) : (
          <>
            On pace · {pct}% there
            {goal.monthlyNeededMinor !== null && (
              <>
                {" · "}
                <Money
                  value={formatMoney(goal.monthlyNeededMinor, goal.currencyCode)}
                />
                /mo keeps you on track
              </>
            )}
          </>
        )}
      </p>
    </li>
  );
}

function Money({ value }: { value: string }) {
  return <span className="font-amount tabular-nums">{value}</span>;
}

/* ───────────────────────────── Committed ────────────────────────────── */

/**
 * What every month is already spoken for — recurring money and bills as one
 * proportional bar, so the make-up of the commitment reads before the figures.
 */
function Committed({ future, currency }: { future: FutureView; currency: string }) {
  const total = future.committedMonthlyMinor;
  if (total === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
        No recurring money or bills set up yet.
      </p>
    );
  }
  const recPct = Math.round((future.recurringMonthlyMinor / total) * 100);

  return (
    <div className="mt-3">
      <p className="font-amount text-[clamp(1.75rem,3.2vw,2.25rem)] leading-none font-medium tracking-tight text-foreground tabular-nums">
        {formatMoney(total, currency)}
        <span className="ml-1.5 text-base font-normal text-muted-foreground">
          /mo
        </span>
      </p>

      <div className="mt-5 flex h-2.5 w-full gap-1 overflow-hidden rounded-full bg-foreground/[0.05]">
        {future.recurringMonthlyMinor > 0 && (
          <span
            className="grow-x h-full rounded-full bg-primary"
            style={{ width: `${recPct}%`, "--i": 0 } as React.CSSProperties}
          />
        )}
        {future.billsMonthlyMinor > 0 && (
          <span
            className="grow-x h-full flex-1 rounded-full bg-chart-3"
            style={{ "--i": 1 } as React.CSSProperties}
          />
        )}
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Legend
          swatch="bg-primary"
          label="Recurring"
          value={formatMoney(future.recurringMonthlyMinor, currency)}
        />
        <Legend
          swatch="bg-chart-3"
          label="Bills"
          value={formatMoney(future.billsMonthlyMinor, currency)}
        />
      </dl>
    </div>
  );
}

function Legend({
  swatch,
  label,
  value,
}: {
  swatch: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("size-2 shrink-0 translate-y-px rounded-[3px]", swatch)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-amount tabular-nums">{value}</span>
    </div>
  );
}

/* ────────────────────────────── Agenda ──────────────────────────────── */

function Agenda({ future }: { future: FutureView }) {
  return (
    <ul className="mt-3 space-y-0.5">
      {future.upcomingBills.map(({ bill, state, daysUntilDue }) => {
        const overdue = state === "overdue";
        return (
          <li key={bill.id} className="flex items-center gap-3 py-1.5">
            <span
              className={cn(
                "flex h-9 w-12 shrink-0 flex-col items-center justify-center rounded-md text-[0.6875rem] leading-none font-medium tabular-nums",
                overdue
                  ? "bg-destructive/10 text-destructive"
                  : daysUntilDue <= 3
                    ? "bg-warning/10 text-warning"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {overdue ? (
                "late"
              ) : daysUntilDue === 0 ? (
                "today"
              ) : (
                <>
                  <span className="font-amount text-sm">{daysUntilDue}</span>
                  <span className="opacity-70">days</span>
                </>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{bill.name}</p>
              <p className="text-xs text-muted-foreground">
                {overdue
                  ? `was due ${formatDate(bill.nextDueDate)}`
                  : `due ${formatRelativeDays(daysUntilDue)}`}
              </p>
            </div>
            <span className="font-amount text-sm tabular-nums">
              {formatMoney(
                Math.abs(bill.expectedAmountMinor),
                bill.currencyCode,
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ─────────────────────────────── Empty ──────────────────────────────── */

function Empty({
  title,
  body,
  href,
  cta,
  icon,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
  icon?: boolean;
}) {
  return (
    <div className="mt-5 flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
      {icon && (
        <HugeiconsIcon
          icon={Target01Icon}
          className="size-7 text-muted-foreground/50"
          strokeWidth={1.6}
        />
      )}
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      <Link
        href={href}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:opacity-80"
      >
        <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-3.5" strokeWidth={2} />
        {cta}
      </Link>
    </div>
  );
}
