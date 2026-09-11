import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { formatDate, formatMonth, formatMoney } from "@/lib/format";
import { listAccounts } from "@/modules/accounts/queries";
import { buildUserForecastDetailed, getPurchasePlanImpact } from "@/modules/finance/queries";
import type { MonthlyOutlookEntry, PurchasePlanSimulation } from "@hermes-finance/planning";
import { Badge } from "@/components/ui/badge";
import { SimulationBalanceChart } from "@/components/plan/simulation-balance-chart";
import { cn } from "@/lib/utils";
import { PurchaseItemActions } from "../item-actions";
import { NewPurchaseItemDialog } from "./new-item-dialog";
import { PurchasePlanActions } from "../plan-actions";
import { PlanTotalsLine } from "../plan-totals";

export const metadata: Metadata = { title: "Purchase plan" };

/** Matches the horizon `getPurchasePlanImpact` builds its own forecast over. */
const PLAN_HORIZON_DAYS = 365;

const REJECTION_LABEL: Record<string, string> = {
  HARD_RESERVE_VIOLATED: "Breaks the protected reserve",
  NEGATIVE_BALANCE: "Drives the balance below zero",
  CREDIT_LIMIT_EXCEEDED: "Exceeds the card limit",
  DEADLINE_EXCEEDED: "Bought after it is needed",
};

/**
 * One plan: the things you intend to buy, and what buying them does to the
 * horizon.
 *
 * There is no recommending here. An item states when it is bought, for how
 * much and out of which account; the engine folds that whole basket into one
 * forecast and this page renders the damage. Nothing below adds, divides or
 * rounds money — every figure is one `simulatePurchasePlan` already decided.
 */
export default async function PurchasePlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const [impact, accounts, baseline] = await Promise.all([
    getPurchasePlanImpact(user.id, id),
    listAccounts(user.id),
    buildUserForecastDetailed(user.id, PLAN_HORIZON_DAYS),
  ]);
  if (!impact) notFound();

  const { plan, simulation, unprojectedItems } = impact;
  const accountOptions = accounts.map((account) => ({
    id: account.id,
    name: account.name,
    type: account.type,
  }));
  const accountById = new Map(accountOptions.map((account) => [account.id, account]));

  // Joined on the date, not the position: the two forecasts are built by
  // separate calls, each resolving "today" on its own, so a render across
  // midnight would shift one series against the other. Days without a
  // counterpart are dropped rather than defaulted.
  const baselineByDate = new Map(
    baseline.forecast.days.map((day) => [day.date, day.closingBalanceMinor]),
  );
  const chartData = simulation
    ? simulation.forecastAfter.days.flatMap((day) => {
        const beforeMinor = baselineByDate.get(day.date);
        if (beforeMinor === undefined) return [];
        return [{ date: day.date, afterMinor: day.closingBalanceMinor, beforeMinor }];
      })
    : [];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{plan.name}</h2>
          <p className="text-sm text-muted-foreground">
            {plan.description ? `${plan.description} · ` : ""}
            {plan.targetDate ? `Target ${formatDate(plan.targetDate)}` : "No target date"}
          </p>
          <PlanTotalsLine
            className="mt-1"
            totals={{
              estimatedTotalMinor: plan.estimatedTotalMinor,
              remainingEstimateMinor: plan.remainingEstimateMinor,
              purchasedTotalMinor: plan.purchasedTotalMinor,
              overBudgetMinor: plan.overBudgetMinor,
              underBudgetMinor: plan.underBudgetMinor,
              budgetMinor: plan.budgetMinor,
              currencyCode: plan.currencyCode,
            }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NewPurchaseItemDialog
            purchasePlanId={plan.id}
            currencyCode={plan.currencyCode}
            accounts={accountOptions}
          />
          <PurchasePlanActions
            plan={{
              id: plan.id,
              name: plan.name,
              description: plan.description,
              targetDate: plan.targetDate,
              budgetMinor: plan.budgetMinor,
              currencyCode: plan.currencyCode,
              status: plan.status,
            }}
            redirectAfterDelete
          />
        </div>
      </div>

      {plan.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          Nothing in this plan yet. Add what you intend to buy, when, and out of which account.
        </div>
      ) : (
        <ul className="divide-y divide-dashed rounded-xl border border-border/60 bg-card px-4">
          {plan.items.map((item) => {
            const account = item.accountId ? accountById.get(item.accountId) : undefined;
            return (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm">{item.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {item.purchaseDate ? formatDate(item.purchaseDate) : "no date yet"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  {account ? (
                    <Badge variant="outline" className="text-[10px]">
                      {account.name}
                    </Badge>
                  ) : (
                    <span>no account yet</span>
                  )}
                  {item.installments > 1 && <span>{item.installments}×</span>}
                  <span className="font-amount tabular-nums text-foreground">
                    {formatMoney(item.estimatedPriceMinor, plan.currencyCode)}
                  </span>
                  <PurchaseItemActions
                    item={{
                      id: item.id,
                      name: item.name,
                      estimatedPriceMinor: item.estimatedPriceMinor,
                      purchaseDate: item.purchaseDate,
                      accountId: item.accountId,
                      installments: item.installments,
                    }}
                    currencyCode={plan.currencyCode}
                    accounts={accountOptions}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {unprojectedItems.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-4 text-xs text-muted-foreground">
          <HugeiconsIcon icon={InformationCircleIcon} className="mt-0.5 size-4 shrink-0" />
          <p>
            Left out of the projection until it has both a purchase date and an account:{" "}
            <span className="text-foreground">
              {unprojectedItems.map((item) => item.name).join(", ")}
            </span>
            .
          </p>
        </div>
      )}

      {simulation && (
        <HorizonImpact
          simulation={simulation}
          chartData={chartData}
          currencyCode={plan.currencyCode}
        />
      )}
    </div>
  );
}

/** What the basket does to the horizon, as the engine returned it. */
function HorizonImpact({
  simulation,
  chartData,
  currencyCode,
}: {
  simulation: PurchasePlanSimulation;
  chartData: Array<{ date: string; afterMinor: number; beforeMinor: number }>;
  currencyCode: string;
}) {
  const fits = simulation.feasible;

  return (
    <section className="glass-panel space-y-6 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={fits ? CheckmarkCircle02Icon : Alert02Icon}
            className={cn("size-5", fits ? "text-success" : "text-destructive")}
          />
          <h3 className="text-sm font-semibold">
            {fits ? "This fits on the horizon" : "This does not fit on the horizon"}
          </h3>
        </div>
        <span className="font-amount text-sm tabular-nums text-muted-foreground">
          {formatMoney(simulation.totalCostMinor, currencyCode)} total
        </span>
      </div>

      {simulation.rejections.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {simulation.rejections.map((rejection) => (
            <li
              key={rejection}
              className="rounded-full bg-destructive/10 px-2 py-0.5 text-[0.625rem] font-medium text-destructive"
            >
              {REJECTION_LABEL[rejection] ?? rejection}
            </li>
          ))}
        </ul>
      )}

      <dl className="grid gap-6 sm:grid-cols-2">
        <BeforeAfter
          label="Minimum balance"
          beforeMinor={simulation.minimumBalanceBeforeMinor}
          afterMinor={simulation.minimumBalanceAfterMinor}
          note={`on ${formatDate(simulation.minimumBalanceAfterDate)}`}
          currencyCode={currencyCode}
        />
        <BeforeAfter
          label="Safe to spend"
          beforeMinor={simulation.safeToSpendBeforeMinor}
          afterMinor={simulation.safeToSpendAfterMinor}
          currencyCode={currencyCode}
        />
      </dl>

      {simulation.softReserveImpacts.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {simulation.softReserveImpacts.map((impact) => (
            <li key={impact.id}>
              Eats {formatMoney(impact.shortfallMinor, currencyCode)} into the “{impact.name}” goal.
            </li>
          ))}
        </ul>
      )}

      <div>
        <span className="micro-label">Balance, vs without this plan</span>
        <div className="mt-3">
          <SimulationBalanceChart data={chartData} currencyCode={currencyCode} />
        </div>
      </div>

      {simulation.monthlyOutlook.length > 0 && (
        <div>
          <span className="micro-label">Month by month</span>
          <MonthlyOutlookTable entries={simulation.monthlyOutlook} currencyCode={currencyCode} />
        </div>
      )}

      {simulation.cards.length > 0 && (
        <div>
          <span className="micro-label">Card load</span>
          <ul className="mt-2 divide-y divide-dashed">
            {simulation.cards.map((card) => (
              <li
                key={card.cardId}
                className="flex items-center justify-between gap-2 py-1.5 text-xs first:pt-0 last:pb-0"
              >
                <span>{card.label}</span>
                <span className="flex items-center gap-2">
                  <span className="font-amount tabular-nums text-muted-foreground">
                    {formatMoney(card.committedMinor + card.planChargedMinor, currencyCode)}
                    {" / "}
                    {formatMoney(card.creditLimitMinor, currencyCode)}
                  </span>
                  {card.exceededMinor > 0 && (
                    <Badge variant="destructive" className="text-[10px]">
                      +{formatMoney(card.exceededMinor, currencyCode)} over
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function BeforeAfter({
  label,
  beforeMinor,
  afterMinor,
  note,
  currencyCode,
}: {
  label: string;
  beforeMinor: number;
  afterMinor: number;
  note?: string;
  currencyCode: string;
}) {
  return (
    <div>
      <dt className="micro-label">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-2">
        <span className="font-amount text-sm tabular-nums text-muted-foreground line-through decoration-muted-foreground/40">
          {formatMoney(beforeMinor, currencyCode)}
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="font-amount text-lg font-medium tabular-nums">
          {formatMoney(afterMinor, currencyCode)}
        </span>
      </dd>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * Drops trailing months where this plan does nothing — no outflow, and the
 * low point never dips below zero — so a long horizon doesn't end in a wall
 * of empty rows. A negative low point is never trimmed, even at the tail:
 * it is exactly the kind of month this table exists to surface.
 */
function trimQuietTail(entries: MonthlyOutlookEntry[]): MonthlyOutlookEntry[] {
  let end = entries.length;
  while (end > 0) {
    const entry = entries[end - 1]!;
    if (entry.purchaseOutflowMinor !== 0 || entry.minimumBalanceMinor < 0) break;
    end -= 1;
  }
  return entries.slice(0, end);
}

/**
 * Answers "what does this cost me each month, and what's left". Every column
 * is a field `simulatePurchasePlan` already computed on the same forecast the
 * verdict above is — nothing here sums or nets minor units.
 */
function MonthlyOutlookTable({
  entries,
  currencyCode,
}: {
  entries: MonthlyOutlookEntry[];
  currencyCode: string;
}) {
  const rows = trimQuietTail(entries);
  if (rows.length === 0) return null;

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="py-1.5 text-left font-normal">Month</th>
            <th className="py-1.5 text-right font-normal">This plan takes out</th>
            <th className="py-1.5 text-right font-normal">Low point</th>
            <th className="py-1.5 text-right font-normal">Ends at</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-dashed">
          {rows.map((entry) => {
            const negative = entry.minimumBalanceMinor < 0;
            return (
              <tr key={entry.month}>
                <td className="py-1.5 text-muted-foreground">{formatMonth(entry.month)}</td>
                <td className="py-1.5 text-right font-amount tabular-nums">
                  {entry.purchaseOutflowMinor > 0
                    ? formatMoney(entry.purchaseOutflowMinor, currencyCode)
                    : "—"}
                </td>
                <td
                  className={cn(
                    "py-1.5 text-right font-amount tabular-nums",
                    negative && "font-medium text-destructive",
                  )}
                >
                  {formatMoney(entry.minimumBalanceMinor, currencyCode)}
                </td>
                <td className="py-1.5 text-right font-amount tabular-nums">
                  {formatMoney(entry.closingBalanceMinor, currencyCode)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
