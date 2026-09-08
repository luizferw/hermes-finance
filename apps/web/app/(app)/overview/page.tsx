import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  InboxIcon,
  Invoice01Icon,
  MagicWand01Icon,
  PieChart01Icon,
  PulseIcon,
} from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { formatAbsAmount, formatDateShort, formatMoney, formatRelativeDays } from "@/lib/format";
import { BAND_LABEL, type ConfidenceFactor } from "@kosh/domain";
import { getConfidence, type ConfidenceView } from "@/modules/confidence/queries";
import { getNetWorthSummary, listAccounts } from "@/modules/accounts/queries";
import {
  getMonthSummary,
  getNetWorthSeries,
  getSpendingByCategory,
} from "@/modules/reports/queries";
import {
  getInboxCount,
  getRecentTransactions,
} from "@/modules/transactions/queries";
import { listBills } from "@/modules/bills/queries";
import { listBudgetsWithProgress } from "@/modules/budgets/queries";
import { getRuleSuggestions } from "@/modules/rules/queries";
import { getSystemHealth } from "@/modules/system/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import { AskKosh } from "@/components/home/ask-kosh";
import { SafeToSpendCard } from "@/components/home/safe-to-spend-card";
import { SetupChecklist } from "@/components/home/setup-checklist";
import { Amount } from "@/components/transactions/amount";
import { CategoryBadge } from "@/components/transactions/category-badge";
import { NetWorthSpark } from "@/components/dashboard/net-worth-spark";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const user = await requireUser();
  const [
    settings,
    confidence,
    netWorth,
    monthSummary,
    netWorthData,
    spending,
    inboxCount,
    recent,
    bills,
    budgets,
    suggestions,
    health,
    accounts,
  ] = await Promise.all([
    getUserSettings(user.id),
    getConfidence(user.id),
    getNetWorthSummary(user.id),
    getMonthSummary(user.id),
    getNetWorthSeries(user.id),
    getSpendingByCategory(user.id),
    getInboxCount(user.id),
    getRecentTransactions(user.id, 8),
    listBills(user.id),
    listBudgetsWithProgress(user.id),
    getRuleSuggestions(user.id),
    getSystemHealth(),
    listAccounts(user.id),
  ]);

  const currency = settings.currencyCode;
  const upcomingBills = bills.filter(
    (b) => b.bill.isActive && (b.state === "overdue" || b.daysUntilDue <= 14),
  );
  const firstName = user.name.split(" ")[0] ?? user.name;
  const hour = new Date().getHours();
  const greeting =
    hour < 5
      ? "Up late"
      : hour < 12
        ? "Good morning"
        : hour < 17
          ? "Good afternoon"
          : "Good evening";
  const healthOk = health.checks.every((c) => c.status === "ok");
  const healthIssues = health.checks.filter((c) => c.status !== "ok").length;
  const activeAccounts = accounts.filter((a) => !a.isArchived);
  const overBudgets = budgets.filter((b) => b.isOver);
  const monthLabel = new Intl.DateTimeFormat("en-IN", { month: "long" }).format(
    new Date(),
  );

  // Safe to spend = earned − spent − active bills still due by month end,
  // all in the user's default currency.
  const _now = new Date();
  const monthEndIso = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}-${String(new Date(_now.getFullYear(), _now.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
  const committedMinor = bills
    .filter(
      (b) =>
        b.bill.isActive &&
        b.bill.currencyCode === currency &&
        b.bill.nextDueDate <= monthEndIso,
    )
    .reduce((sum, b) => sum + b.bill.expectedAmountMinor, 0);
  const safeMinor =
    monthSummary.incomeMinor - monthSummary.expenseMinor - committedMinor;

  // Net-worth trajectory across the series — the felt direction of the figure.
  const first = netWorthData[0]?.netWorthMinor ?? 0;
  const last = netWorthData.at(-1)?.netWorthMinor ?? netWorth.netWorthMinor;
  const delta = last - first;
  const hasTrend = netWorthData.length > 1;

  // First run: no accounts means the standing/confidence views would all read
  // zero. Replace the dashboard with a focused, guided start instead.
  if (accounts.length === 0) {
    return (
      <>
        <PageHeader
          title={`${greeting}, ${firstName}`}
          description="Let's get your money set up."
        />
        <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8 md:px-8 md:py-10">
          <div className="row-in" style={{ "--i": 0 } as React.CSSProperties}>
            <AskKosh />
          </div>
          <div className="row-in" style={{ "--i": 1 } as React.CSSProperties}>
            <SetupChecklist
              hasAccount={false}
              hasTransaction={recent.length > 0}
              hasSalaryDay={false}
            />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${greeting}, ${firstName}`}
        description={`${confidence.read} Totals use ${currency}; foreign-currency activity is excluded.`}
      />

      <main className="mx-auto w-full max-w-screen-2xl space-y-9 px-4 py-6 md:space-y-12 md:px-8 md:py-8">
        {/* ── Movement 0 · Ask kosh — the lead, the command surface ─────── */}
        <section className="row-in" style={{ "--i": 0 } as React.CSSProperties}>
          <AskKosh />
        </section>

        {/* ── Movement I · Confidence — where you stand ─────────────────── */}
        <section
          className="row-in"
          style={{ "--i": 1 } as React.CSSProperties}
          aria-label="Your financial confidence"
        >
          <ConfidenceHero c={confidence} />
        </section>

        {/* ── Movement II · What's lifting, what's weighing ─────────────── */}
        <section
          className="row-in"
          style={{ "--i": 1 } as React.CSSProperties}
          aria-label="What's lifting and weighing on your confidence"
        >
          <LiftWeigh lifting={confidence.lifting} weighing={confidence.weighing} />
        </section>

        {/* ── Movement III · What needs you ─────────────────────────────── */}
        <section
          className="row-in"
          style={{ "--i": 2 } as React.CSSProperties}
          aria-label="What needs you"
        >
          <AttentionRow
            inboxCount={inboxCount}
            bills={upcomingBills}
            overBudgets={overBudgets.length}
            suggestions={suggestions.length}
            healthOk={healthOk}
            healthIssues={healthIssues}
          />
        </section>

        <hr className="border-border/60" />

        {/* ── Movement IV · The standing ────────────────────────────────── */}
        <section
          className="row-in grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
          style={{ "--i": 3 } as React.CSSProperties}
          aria-label="Your standing"
        >
          {/* Net worth — the figure as hero, trend woven beneath. */}
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="micro-label">Net worth</span>
              {hasTrend && <DeltaChip delta={delta} currency={currency} />}
            </div>
            <p className="mt-1.5 font-amount text-[clamp(2.5rem,6vw,3.75rem)] leading-[0.95] font-medium tracking-[-0.03em] text-foreground tabular-nums">
              {formatMoney(netWorth.netWorthMinor, currency)}
            </p>

            {hasTrend ? (
              <NetWorthSpark
                data={netWorthData}
                currencyCode={currency}
                className="mt-4 h-14 w-full"
              />
            ) : (
              <div className="mt-4 h-14" />
            )}

            <AssetsLiabilitiesMeter
              assets={netWorth.assetsMinor}
              liabilities={netWorth.liabilitiesMinor}
              currency={currency}
            />
          </div>

          {/* This month — income, spend, kept as one relationship. */}
          <div className="min-w-0 lg:border-l lg:border-border/60 lg:pl-12">
            <span className="micro-label">This month · {monthLabel}</span>
            <MonthFlow
              earned={monthSummary.incomeMinor}
              spent={monthSummary.expenseMinor}
              net={monthSummary.netMinor}
              currency={currency}
            />

            <div className="mt-6">
              <SafeToSpendCard
                safeMinor={safeMinor}
                incomeMinor={monthSummary.incomeMinor}
                expenseMinor={monthSummary.expenseMinor}
                committedMinor={committedMinor}
                currency={currency}
              />
            </div>
          </div>
        </section>

        {/* ── Movement V · The detail (asymmetric) ──────────────────────── */}
        <section
          className="row-in grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
          style={{ "--i": 4 } as React.CSSProperties}
        >
          {/* Where it went — ranked weight bars (this month). */}
          <div className="min-w-0">
            <SectionHead
              label={`Where it went · ${monthLabel}`}
              href="/reports"
              cta="Reports"
            />
            {spending.length > 0 ? (
              <WeightBars data={spending} currency={currency} />
            ) : (
              <Quiet>No spending recorded this month yet.</Quiet>
            )}
          </div>

          {/* Coming up — bills agenda + where money sits. */}
          <div className="min-w-0 space-y-8 lg:border-l lg:border-border/60 lg:pl-12">
            <div>
              <SectionHead label="Coming up" href="/plan/bills" cta="Bills" />
              {upcomingBills.length > 0 ? (
                <BillsAgenda bills={upcomingBills} />
              ) : (
                <Quiet>Nothing due in the next two weeks.</Quiet>
              )}
            </div>

            {activeAccounts.length > 0 && (
              <div>
                <SectionHead
                  label="Accounts"
                  href="/accounts"
                  cta="All accounts"
                />
                <ul className="mt-3 space-y-2.5">
                  {activeAccounts.slice(0, 5).map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <Link
                        href={`/accounts/${a.id}`}
                        className="truncate text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {a.name}
                      </Link>
                      <Amount
                        amountMinor={a.currentBalanceMinor}
                        currencyCode={a.currencyCode}
                        className="text-[0.8125rem]"
                        muted={a.currentBalanceMinor < 0}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <hr className="border-border/60" />

        {/* ── Movement VI · Latest activity (ledger strip) ──────────────── */}
        <section
          className="row-in"
          style={{ "--i": 5 } as React.CSSProperties}
        >
          <SectionHead
            label="Latest activity"
            href="/transactions"
            cta="All transactions"
          />
          {recent.length > 0 ? (
            <ul className="mt-1">
              {recent.map((tx, i) => (
                <li
                  key={tx.id}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 border-b border-border/50 py-2.5 last:border-0 sm:grid-cols-[5.5rem_1fr_auto_auto]"
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <span className="font-amount text-xs text-muted-foreground tabular-nums">
                    {formatDateShort(tx.date)}
                  </span>
                  <span className="min-w-0 truncate text-sm">
                    {tx.description}
                  </span>
                  <CategoryBadge
                    category={tx.category}
                    className="col-start-2 row-start-2 mt-0.5 w-fit px-1.5 py-0 text-[10px] sm:col-start-3 sm:row-start-1 sm:mt-0 sm:justify-self-end"
                  />
                  <Amount
                    amountMinor={tx.amountMinor}
                    currencyCode={tx.currencyCode}
                    className="col-start-3 row-start-1 self-center text-sm sm:col-start-4"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>Transactions appear here once recorded.</Quiet>
          )}
        </section>
      </main>
    </>
  );
}

/* ──────────────────────────── Confidence ────────────────────────────── */

const STATUS_COLOR: Record<ConfidenceFactor["status"], string> = {
  lifting: "var(--primary)",
  steady: "var(--muted-foreground)",
  weighing: "var(--destructive)",
};

/**
 * The lead of the page. Confidence is stated in words first — a calm band word
 * at display scale — with the score and weekly drift in support, then the
 * plain-language read. The right rail carries "the shape of it": the six
 * factors as a small equalizer of bars that rise on mount, so the make-up of
 * the score is legible at a glance before a single list is read.
 */
function ConfidenceHero({ c }: { c: ConfidenceView }) {
  return (
    <div className="grid gap-x-12 gap-y-9 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-end">
      <div className="min-w-0">
        <span className="micro-label">Where you stand</span>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-[clamp(2.25rem,5vw,3.25rem)] leading-[0.95] font-medium tracking-[-0.02em] text-balance text-foreground">
            {BAND_LABEL[c.band]}
          </h2>
          <span className="flex items-baseline gap-1.5">
            <span className="font-amount text-2xl font-medium text-muted-foreground tabular-nums">
              {c.score}
            </span>
            <span className="font-amount text-sm text-muted-foreground/60">
              / 100
            </span>
          </span>
          {c.weekDelta !== null && c.weekDelta !== 0 && (
            <ConfDeltaChip delta={c.weekDelta} />
          )}
        </div>
        <p className="mt-3.5 max-w-[48ch] text-sm leading-relaxed text-pretty text-muted-foreground">
          {c.read}
        </p>
        {(c.streakDays > 0 || c.trend.length > 1) && (
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
            {c.streakDays > 0 && <StreakMark days={c.streakDays} />}
            {c.trend.length > 1 && <ConfidenceSpark trend={c.trend} />}
          </div>
        )}
      </div>

      <div className="min-w-0">
        <span className="micro-label">The shape of it</span>
        <FactorShape factors={c.factors} />
      </div>
    </div>
  );
}

/** Weekly drift in the score — direction carried by glyph as well as colour. */
function ConfDeltaChip({ delta }: { delta: number }) {
  const up = delta > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        up ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
      )}
    >
      <span aria-hidden className="font-amount leading-none">
        {up ? "↑" : "↓"}
      </span>
      <span className="font-amount">{Math.abs(delta)}</span>
      <span className="font-normal opacity-70">this week</span>
    </span>
  );
}

/**
 * The six confidence factors as a slim equalizer. Each bar's height is its
 * 0–100 sub-score; colour encodes status but is always paired with the label
 * and the number beneath, so meaning never rests on hue alone. Bars rise from
 * their base on mount (grow-y), staggered left to right.
 */
function FactorShape({ factors }: { factors: ConfidenceFactor[] }) {
  return (
    <ul className="mt-4 grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-6">
      {factors.map((f, i) => (
        <li
          key={f.key}
          className="flex flex-col items-center gap-2"
          title={`${f.label}: ${f.note}`}
        >
          <div className="flex h-24 w-full items-end justify-center">
            <div className="relative h-full w-2.5 overflow-hidden rounded-full bg-foreground/[0.06]">
              <span
                className="grow-y absolute inset-x-0 bottom-0 rounded-full"
                style={
                  {
                    height: `${Math.max(4, f.score)}%`,
                    background: STATUS_COLOR[f.status],
                    "--i": i,
                  } as React.CSSProperties
                }
              />
            </div>
          </div>
          <span className="text-center text-[0.625rem] leading-tight font-medium tracking-[0.02em] text-muted-foreground">
            {f.label}
          </span>
          <span className="font-amount text-[0.6875rem] text-muted-foreground/70 tabular-nums">
            {f.score}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The habit signal — consecutive days the slate stayed clean. */
function StreakMark({ days }: { days: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-primary/[0.08] py-1 pr-3 pl-2.5 text-xs text-foreground ring-1 ring-inset ring-primary/15">
      <span aria-hidden className="font-amount text-sm leading-none text-primary">
        ↑
      </span>
      <span>
        On top{" "}
        <span className="font-amount font-semibold tabular-nums">{days}</span>{" "}
        {days === 1 ? "day" : "days"}
      </span>
    </span>
  );
}

/** A hairline sparkline of the confidence score over the last weeks. */
function ConfidenceSpark({ trend }: { trend: ConfidenceView["trend"] }) {
  const w = 88;
  const h = 22;
  const scores = trend.map((t) => t.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min || 1;
  const step = trend.length > 1 ? w / (trend.length - 1) : w;
  const pts = scores.map((s, i) => {
    const x = i * step;
    const y = h - 2 - ((s - min) / span) * (h - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        fill="none"
        aria-hidden
        className="overflow-visible"
      >
        <polyline
          points={pts.join(" ")}
          stroke="var(--primary)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.85}
        />
        <circle
          cx={(trend.length - 1) * step}
          cy={h - 2 - ((scores.at(-1)! - min) / span) * (h - 4)}
          r={2}
          fill="var(--primary)"
        />
      </svg>
      <span className="hidden sm:inline">last {trend.length} days</span>
    </span>
  );
}

/**
 * The two questions a person asks of their money, answered side by side: what's
 * lifting confidence (steady, no action) and what's weighing on it (each a
 * place to go act). Steady factors sit between the two and stay quiet.
 */
function LiftWeigh({
  lifting,
  weighing,
}: {
  lifting: ConfidenceFactor[];
  weighing: ConfidenceFactor[];
}) {
  return (
    <div className="grid gap-x-12 gap-y-8 md:grid-cols-2">
      <div className="min-w-0">
        <h2 className="micro-label">Lifting you</h2>
        {lifting.length > 0 ? (
          <ul className="mt-3.5">
            {lifting.map((f, i) => (
              <FactorLine key={f.key} factor={f} index={i} />
            ))}
          </ul>
        ) : (
          <Quiet>Nothing&apos;s pulling ahead yet — keep going.</Quiet>
        )}
      </div>
      <div className="min-w-0 md:border-l md:border-border/60 md:pl-12">
        <h2 className="micro-label">Weighing on you</h2>
        {weighing.length > 0 ? (
          <ul className="mt-3.5">
            {weighing.map((f, i) => (
              <FactorLine key={f.key} factor={f} index={i} actionable />
            ))}
          </ul>
        ) : (
          <p className="mt-4 flex items-center gap-2.5 text-sm text-muted-foreground">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-[18px] text-success"
              strokeWidth={1.8}
            />
            Nothing&apos;s weighing on you right now.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One factor as a ledger row: a status dot (paired with the label, never hue
 * alone), the plain read, and the sub-score. Weighing rows are links to the
 * place you'd go to fix them and reveal an arrow on hover.
 */
function FactorLine({
  factor,
  index,
  actionable,
}: {
  factor: ConfidenceFactor;
  index: number;
  actionable?: boolean;
}) {
  const inner = (
    <>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: STATUS_COLOR[factor.status] }}
      />
      <span className="w-[5.5rem] shrink-0 text-sm font-medium text-foreground">
        {factor.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {factor.note}
      </span>
      <span className="font-amount text-xs text-muted-foreground/70 tabular-nums">
        {factor.score}
      </span>
      {actionable && (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover/factor:translate-x-0.5 group-hover/factor:text-muted-foreground"
          strokeWidth={2}
        />
      )}
    </>
  );

  const className =
    "flex items-center gap-3 border-b border-border/50 py-2.5 last:border-0";

  if (actionable) {
    return (
      <li style={{ "--i": index } as React.CSSProperties}>
        <Link
          href={factor.href}
          className={cn(
            "group/factor -mx-2 rounded-md px-2 transition-colors duration-[var(--duration-state)] ease-[var(--ease-out-quint)] hover:bg-foreground/[0.025]",
            className,
          )}
        >
          {inner}
        </Link>
      </li>
    );
  }
  return (
    <li
      className={className}
      style={{ "--i": index } as React.CSSProperties}
    >
      {inner}
    </li>
  );
}

/* ───────────────────────── Position pieces ──────────────────────────── */

/** Trajectory chip — direction + magnitude of the net-worth change. */
function DeltaChip({ delta, currency }: { delta: number; currency: string }) {
  const up = delta >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        up
          ? "bg-primary/10 text-primary"
          : "bg-destructive/10 text-destructive",
      )}
    >
      <span aria-hidden className="font-amount text-[0.875em] leading-none">
        {up ? "↑" : "↓"}
      </span>
      <span className="font-amount">
        {formatMoney(Math.abs(delta), currency)}
      </span>
      <span className="font-normal opacity-70">this quarter</span>
    </span>
  );
}

/**
 * What you own against what you owe, as one proportional rule. Fern carries
 * assets, clay carries liabilities; the split width is the truth of the ratio,
 * so the balance of the two is legible before the figures are even read.
 */
function AssetsLiabilitiesMeter({
  assets,
  liabilities,
  currency,
}: {
  assets: number;
  liabilities: number;
  currency: string;
}) {
  const total = assets + liabilities;
  const assetPct = total > 0 ? (assets / total) * 100 : 100;
  return (
    <div className="mt-5">
      <div className="flex h-2 w-full gap-1 overflow-hidden rounded-full">
        <span
          className="grow-x h-full rounded-full bg-primary"
          style={{ width: `${assetPct}%`, "--i": 0 } as React.CSSProperties}
        />
        {liabilities > 0 && (
          <span
            className="grow-x h-full flex-1 rounded-full bg-destructive/55"
            style={{ "--i": 1 } as React.CSSProperties}
          />
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between text-xs">
        <span className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground">Assets</span>
          <span className="font-amount text-foreground tabular-nums">
            {formatMoney(assets, currency)}
          </span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground">Owe</span>
          <span className="font-amount text-foreground tabular-nums">
            {formatMoney(liabilities, currency)}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * The month as a single flow: everything earned is the track; what's been spent
 * fills it from the left in clay, what's kept rides as the fern remainder. The
 * three figures and the savings rate hang off that one bar, so income, spend,
 * and cashflow read as one relationship rather than three lonely metrics.
 */
function MonthFlow({
  earned,
  spent,
  net,
  currency,
}: {
  earned: number;
  spent: number;
  net: number;
  currency: string;
}) {
  const overspent = spent > earned;
  const spentPct = earned > 0 ? Math.min(100, (spent / earned) * 100) : spent > 0 ? 100 : 0;
  const keptPct = Math.max(0, 100 - spentPct);
  const savingsPct = earned > 0 ? Math.round((net / earned) * 100) : null;

  return (
    <div className="mt-3">
      {/* Spent (clay) consumes earned from the left; kept (fern) is what's
          left riding the same track — income, spend, and cashflow as one bar. */}
      <div className="flex h-2.5 w-full gap-1 overflow-hidden rounded-full bg-foreground/[0.05]">
        <span
          className="grow-x h-full rounded-full bg-destructive/55"
          style={{ width: `${spentPct}%`, "--i": 0 } as React.CSSProperties}
        />
        {keptPct > 0 && (
          <span
            className="grow-x h-full flex-1 rounded-full bg-primary"
            style={{ "--i": 1 } as React.CSSProperties}
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <FlowStat label="Earned" value={formatMoney(earned, currency)} />
        <FlowStat label="Spent" value={formatMoney(spent, currency)} />
        <FlowStat
          label="Kept"
          value={formatMoney(net, currency, { signDisplay: "exceptZero" })}
          tone={net >= 0 ? "positive" : "negative"}
          note={
            overspent
              ? "over"
              : savingsPct !== null
                ? `${savingsPct}% saved`
                : undefined
          }
        />
      </div>
    </div>
  );
}

function FlowStat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="micro-label">{label}</p>
      <p
        className={cn(
          "mt-1 truncate font-amount text-lg leading-tight font-medium tracking-tight tabular-nums",
          tone === "positive" && "text-primary",
          tone === "negative" && "text-destructive",
        )}
      >
        {value}
      </p>
      {note && (
        <p
          className={cn(
            "text-[0.6875rem] text-muted-foreground",
            note === "over" && "text-destructive",
          )}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/* ───────────────────────── Attention row ────────────────────────────── */

type BillState = Awaited<ReturnType<typeof listBills>>;

/**
 * The command line of the dashboard. Each pill is a decision waiting to be
 * made; pills only exist when they carry weight, and when the slate is clean
 * the whole row resolves to a single calm acknowledgement. Nothing here is
 * decoration — every item is a place to go act.
 */
function AttentionRow({
  inboxCount,
  bills,
  overBudgets,
  suggestions,
  healthOk,
  healthIssues,
}: {
  inboxCount: number;
  bills: BillState;
  overBudgets: number;
  suggestions: number;
  healthOk: boolean;
  healthIssues: number;
}) {
  const overdue = bills.filter((b) => b.state === "overdue");
  const next = bills[0];
  const items: React.ReactNode[] = [];

  if (inboxCount > 0) {
    items.push(
      <AttentionPill
        key="inbox"
        href="/inbox"
        icon={InboxIcon}
        tone="primary"
        count={inboxCount}
        label={inboxCount === 1 ? "to review" : "to review"}
      />,
    );
  }
  if (bills.length > 0 && next) {
    items.push(
      <AttentionPill
        key="bills"
        href="/plan/bills"
        icon={Invoice01Icon}
        tone={overdue.length > 0 ? "warning" : "default"}
        count={bills.length}
        label={
          overdue.length > 0
            ? `due · ${overdue.length} overdue`
            : `due soon · next ${formatAbsAmount(next.bill.expectedAmountMinor, next.bill.currencyCode)}`
        }
      />,
    );
  }
  if (overBudgets > 0) {
    items.push(
      <AttentionPill
        key="budgets"
        href="/plan/budgets"
        icon={PieChart01Icon}
        tone="destructive"
        count={overBudgets}
        label={overBudgets === 1 ? "budget over" : "budgets over"}
      />,
    );
  }
  if (suggestions > 0) {
    items.push(
      <AttentionPill
        key="rules"
        href="/automations"
        icon={MagicWand01Icon}
        tone="default"
        count={suggestions}
        label={suggestions === 1 ? "rule to add" : "rules to add"}
      />,
    );
  }
  if (!healthOk) {
    items.push(
      <AttentionPill
        key="health"
        href="/settings/health"
        icon={PulseIcon}
        tone="warning"
        count={healthIssues}
        label="health checks"
      />,
    );
  }

  if (items.length === 0) {
    return (
      <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="size-[18px] text-success"
          strokeWidth={1.8}
        />
        Everything&apos;s reconciled — nothing needs you right now.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="micro-label mr-1">Needs you</span>
      {items}
    </div>
  );
}

function AttentionPill({
  href,
  icon,
  count,
  label,
  tone,
}: {
  href: string;
  icon: typeof InboxIcon;
  count: number;
  label: string;
  tone: "primary" | "default" | "warning" | "destructive";
}) {
  const toneCls = {
    primary: "text-primary ring-primary/25 hover:bg-primary/[0.06]",
    default: "text-foreground ring-border hover:bg-foreground/[0.04]",
    warning: "text-warning ring-warning/30 hover:bg-warning/[0.07]",
    destructive: "text-destructive ring-destructive/30 hover:bg-destructive/[0.06]",
  }[tone];
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-2 rounded-full bg-card py-1.5 pr-3.5 pl-2.5 text-sm ring-1 outline-none transition-[background-color,transform] duration-[var(--duration-state)] ease-[var(--ease-out-quint)] ring-inset hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring/60",
        toneCls,
      )}
    >
      <HugeiconsIcon icon={icon} className="size-4 shrink-0" strokeWidth={1.8} />
      <span className="font-amount font-semibold tabular-nums">{count}</span>
      <span className="text-muted-foreground">{label}</span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className="size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover:translate-x-0.5"
        strokeWidth={2}
      />
    </Link>
  );
}

/* ───────────────────────── Detail pieces ────────────────────────────── */

/**
 * Spending ranked by weight. Each bar is scaled against the single largest
 * category, so the longest bar is always full-width and the eye reads the
 * hierarchy of outflows top-down before parsing a single number — faster than
 * a donut for the only question that matters here: where is it going.
 */
function WeightBars({
  data,
  currency,
}: {
  data: Array<{ name: string; color: string | null; spentMinor: number }>;
  currency: string;
}) {
  const top = data.slice(0, 6);
  const total = data.reduce((s, d) => s + d.spentMinor, 0);
  const max = top[0]?.spentMinor ?? 1;

  return (
    <ul className="mt-4 space-y-3.5">
      {top.map((slice, i) => {
        const widthPct = max > 0 ? (slice.spentMinor / max) * 100 : 0;
        const sharePct = total > 0 ? Math.round((slice.spentMinor / total) * 100) : 0;
        const color = slice.color ?? "var(--chart-1)";
        return (
          <li key={slice.name} style={{ "--i": i } as React.CSSProperties}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[3px]"
                  style={{ background: color }}
                />
                <span className="truncate">{slice.name}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="font-amount tabular-nums">
                  {formatMoney(slice.spentMinor, currency)}
                </span>
                <span className="w-8 text-right font-amount text-xs text-muted-foreground tabular-nums">
                  {sharePct}%
                </span>
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.05]">
              <span
                className="grow-x block h-full rounded-full"
                style={{ width: `${widthPct}%`, background: color, "--i": i } as React.CSSProperties}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Bills as a dated agenda — soonest first, overdue flagged in clay. */
function BillsAgenda({ bills }: { bills: BillState }) {
  return (
    <ul className="mt-3 space-y-0.5">
      {bills.slice(0, 5).map(({ bill, state, daysUntilDue }) => {
        const overdue = state === "overdue";
        return (
          <li
            key={bill.id}
            className="flex items-center gap-3 py-1.5"
          >
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
                  ? `was due ${formatDateShort(bill.nextDueDate)}`
                  : `due ${formatRelativeDays(daysUntilDue)}`}
              </p>
            </div>
            <span className="font-amount text-sm tabular-nums">
              {formatAbsAmount(bill.expectedAmountMinor, bill.currencyCode)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────────────────── Shared chrome ────────────────────────────── */

/** A section's running head — micro-label left, quiet text-link right. */
function SectionHead({
  label,
  href,
  cta,
}: {
  label: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="micro-label">{label}</h2>
      <Link
        href={href}
        className="group inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {cta}
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="size-3.5 transition-transform duration-[var(--duration-state)] ease-[var(--ease-out-quint)] group-hover:translate-x-0.5"
          strokeWidth={2}
        />
      </Link>
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-lg border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
