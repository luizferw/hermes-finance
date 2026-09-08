import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import {
  getFinancialYearSummary,
  getMonthlyFlows,
  getNetWorthSeries,
} from "@/modules/reports/queries";
import {
  getPatternsView,
  type CategoryDrift,
} from "@/modules/patterns/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import { IncomeExpenseChart } from "@/components/charts/income-expense-chart";
import { NetWorthChart } from "@/components/charts/net-worth-chart";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Patterns" };

export default async function PatternsPage() {
  const user = await requireUser();
  const settings = await getUserSettings(user.id);
  const [patterns, flows, netWorthData, fy] = await Promise.all([
    getPatternsView(user.id),
    getMonthlyFlows(user.id, 8),
    getNetWorthSeries(user.id, 8),
    getFinancialYearSummary(user.id, settings.financialYearStartMonth),
  ]);
  const currency = settings.currencyCode;
  const monthLabel = new Intl.DateTimeFormat("en-IN", { month: "long" }).format(
    new Date(),
  );

  const rhythmRead =
    patterns.ofMonths === 0
      ? "Not enough history yet to read your rhythm."
      : patterns.keptMonths === patterns.ofMonths
        ? `You've kept money every one of the last ${patterns.ofMonths} months.`
        : `You've kept money in ${patterns.keptMonths} of the last ${patterns.ofMonths} months.`;

  const spendDelta = patterns.thisMonthSpendMinor - patterns.lastMonthSpendMinor;

  return (
    <>
      <PageHeader
        title="Patterns"
        description={`Aggregates use ${currency}; foreign-currency activity is excluded.`}
      />

      <main className="mx-auto w-full max-w-screen-2xl space-y-9 px-4 py-6 md:space-y-12 md:px-8 md:py-8">
        {/* ── Movement I · Your rhythm ──────────────────────────────────── */}
        <section
          className="row-in grid items-end gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
          style={{ "--i": 0 } as React.CSSProperties}
          aria-label="Your rhythm"
        >
          <div className="min-w-0">
            <span className="micro-label">Your rhythm · last 8 months</span>
            <IncomeExpenseChart
              data={flows}
              currencyCode={currency}
              className="mt-4 h-48 w-full"
            />
          </div>
          <div className="min-w-0 lg:border-l lg:border-border/60 lg:pl-12">
            <p className="max-w-[26ch] text-[clamp(1.5rem,2.6vw,2rem)] leading-[1.1] font-medium tracking-[-0.02em] text-balance text-foreground">
              {rhythmRead}
            </p>
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5">
              <Figure
                label="Avg savings rate"
                value={`${patterns.avgSavingsRatePct}%`}
                tone={patterns.avgSavingsRatePct >= 0 ? "positive" : "negative"}
              />
              <Figure
                label="Kept"
                value={`${patterns.keptMonths}/${patterns.ofMonths}`}
                unit="months"
              />
            </dl>
          </div>
        </section>

        <hr className="border-border/60" />

        {/* ── Movement II · Where it goes & what's shifting ─────────────── */}
        <section
          className="row-in grid gap-x-12 gap-y-10 lg:grid-cols-2"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          <div className="min-w-0">
            <h2 className="micro-label">Where it goes · {monthLabel}</h2>
            <WeightBars drift={patterns.drift} currency={currency} />
          </div>
          <div className="min-w-0 lg:border-l lg:border-border/60 lg:pl-12">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="micro-label">What&apos;s shifting</h2>
              <span className="text-xs text-muted-foreground">vs last month</span>
            </div>
            <DriftList drift={patterns.drift} currency={currency} />
            {spendDelta !== 0 && (
              <p className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
                Overall you spent{" "}
                <span className="font-amount tabular-nums text-foreground">
                  {formatMoney(Math.abs(spendDelta), currency)}
                </span>{" "}
                {spendDelta > 0 ? "more" : "less"} than last month.
              </p>
            )}
          </div>
        </section>

        <hr className="border-border/60" />

        {/* ── Movement III · The long arc ───────────────────────────────── */}
        <section
          className="row-in grid items-end gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
          style={{ "--i": 2 } as React.CSSProperties}
          aria-label="The long arc"
        >
          <div className="min-w-0">
            <span className="micro-label">The long arc · net worth</span>
            <NetWorthChart
              data={netWorthData}
              currencyCode={currency}
              className="mt-4 h-56 w-full"
            />
          </div>
          <div className="min-w-0 lg:border-l lg:border-border/60 lg:pl-12">
            <span className="micro-label">{fy.label}</span>
            <dl className="mt-4 space-y-0">
              <ArcStat label="Earned" value={formatMoney(fy.incomeMinor, currency)} />
              <ArcStat label="Spent" value={formatMoney(fy.expenseMinor, currency)} />
              <ArcStat
                label="Saved"
                value={formatMoney(fy.netMinor, currency, {
                  signDisplay: "exceptZero",
                })}
                note={`${fy.savingsRatePct}% of income`}
                tone={fy.netMinor >= 0 ? "positive" : "negative"}
              />
            </dl>
          </div>
        </section>
      </main>
    </>
  );
}

/* ─────────────────────────────── Pieces ─────────────────────────────── */

function Figure({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="min-w-0">
      <dt className="micro-label">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-1.5">
        <span
          className={cn(
            "font-amount text-2xl font-medium tracking-tight tabular-nums",
            tone === "positive" && "text-primary",
            tone === "negative" && "text-destructive",
            !tone && "text-foreground",
          )}
        >
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </dd>
    </div>
  );
}

function ArcStat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-3 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-2">
        {note && (
          <span className="text-[0.6875rem] text-muted-foreground">{note}</span>
        )}
        <span
          className={cn(
            "font-amount text-base font-medium tabular-nums",
            tone === "positive" && "text-primary",
            tone === "negative" && "text-destructive",
          )}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

/**
 * Spending this month ranked by weight against the largest category — the eye
 * reads the hierarchy of outflows before parsing a number.
 */
function WeightBars({
  drift,
  currency,
}: {
  drift: CategoryDrift[];
  currency: string;
}) {
  const spent = drift
    .filter((d) => d.currentMinor > 0)
    .sort((a, b) => b.currentMinor - a.currentMinor)
    .slice(0, 7);
  if (spent.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
        No spending recorded this month yet.
      </p>
    );
  }
  const total = spent.reduce((s, d) => s + d.currentMinor, 0);
  const max = spent[0]!.currentMinor;

  return (
    <ul className="mt-4 space-y-3.5">
      {spent.map((slice, i) => {
        const widthPct = max > 0 ? (slice.currentMinor / max) * 100 : 0;
        const sharePct = total > 0 ? Math.round((slice.currentMinor / total) * 100) : 0;
        const color = slice.color ?? "var(--chart-1)";
        return (
          <li key={slice.key} style={{ "--i": i } as React.CSSProperties}>
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
                  {formatMoney(slice.currentMinor, currency)}
                </span>
                <span className="w-8 text-right font-amount text-xs text-muted-foreground tabular-nums">
                  {sharePct}%
                </span>
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.05]">
              <span
                className="grow-x block h-full rounded-full"
                style={
                  { width: `${widthPct}%`, background: color, "--i": i } as React.CSSProperties
                }
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The behavioural read: which categories moved most against last month. Up is
 * carried by a clay ▲ and "more"; down by a fern ▼ and "less" — direction is
 * never on colour alone.
 */
function DriftList({
  drift,
  currency,
}: {
  drift: CategoryDrift[];
  currency: string;
}) {
  const movers = drift.filter((d) => Math.abs(d.deltaMinor) > 0).slice(0, 6);
  if (movers.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
        Spending held steady against last month.
      </p>
    );
  }
  return (
    <ul className="mt-3.5">
      {movers.map((d, i) => {
        const up = d.deltaMinor > 0;
        return (
          <li
            key={d.key}
            className="flex items-center gap-3 border-b border-border/50 py-2.5 last:border-0"
            style={{ "--i": i } as React.CSSProperties}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[3px]"
              style={{ background: d.color ?? "var(--chart-1)" }}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{d.name}</span>
            <span
              className={cn(
                "flex items-baseline gap-1.5 text-sm",
                up ? "text-destructive" : "text-primary",
              )}
            >
              <span aria-hidden className="font-amount leading-none">
                {up ? "▲" : "▼"}
              </span>
              <span className="font-amount tabular-nums">
                {formatMoney(Math.abs(d.deltaMinor), currency)}
              </span>
              <span className="w-9 text-right text-xs text-muted-foreground">
                {d.isNew ? "new" : up ? "more" : "less"}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
