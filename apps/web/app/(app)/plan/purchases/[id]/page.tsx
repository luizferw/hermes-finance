import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import {
  buildUserForecastDetailed,
  getPurchasePlan,
  getPurchasePlanSimulation,
  listCreditCards,
} from "@/modules/finance/queries";
import { compareStoredPaymentOptions } from "@/modules/finance/simulation";
import { Badge } from "@/components/ui/badge";
import { SimulationBalanceChart } from "@/components/plan/simulation-balance-chart";
import { cn } from "@/lib/utils";
import { PurchaseItemActions } from "../item-actions";
import { NewPurchaseItemDialog } from "./new-item-dialog";
import { PaymentOptionsSection } from "./payment-options-section";
import { PurchasePlanActions } from "../plan-actions";
import { PlanTotalsLine } from "../plan-totals";

export const metadata: Metadata = { title: "Payment options" };

/** Matches the default horizon `getPurchasePlanSimulation` uses internally. */
const PLAN_HORIZON_DAYS = 365;

const PRIORITY_LABEL: Record<string, string> = {
  must_have: "Must have",
  high: "High",
  medium: "Medium",
  low: "Low",
  optional: "Optional",
};

const REJECTION_LABEL: Record<string, string> = {
  HARD_RESERVE_VIOLATED: "Breaks the protected reserve",
  NEGATIVE_BALANCE: "Drives the balance below zero",
  CREDIT_LIMIT_EXCEEDED: "Exceeds the card limit",
  DEADLINE_EXCEEDED: "Finishes after the deadline",
};

type ComparedOption = NonNullable<
  Awaited<ReturnType<typeof compareStoredPaymentOptions>>
>["comparison"]["options"][number];

/**
 * Renders the engine's verdict as sentences a person can read.
 *
 * The engine speaks in canonical minor units — correct for MCP consumers and
 * for an audit trail, wrong for a screen. Every figure below is one the engine
 * already decided; this only formats it. No arithmetic happens here.
 */
function explain(option: ComparedOption, currencyCode: string): string[] {
  const lines: string[] = [];

  lines.push(
    option.hardReserveViolated
      ? `Breaks the protected reserve — the balance bottoms out at ${formatMoney(option.minimumBalanceMinor, currencyCode)} on ${formatDate(option.minimumBalanceDate)}.`
      : `Keeps the protected reserve, with a low of ${formatMoney(option.minimumBalanceMinor, currencyCode)} on ${formatDate(option.minimumBalanceDate)}.`,
  );

  if (option.creditLimitExceededMinor !== undefined) {
    lines.push(`Goes over the card limit by ${formatMoney(option.creditLimitExceededMinor, currencyCode)}.`);
  }

  if (option.installments > 1 && option.lastPaymentDate) {
    lines.push(
      `${option.installments} installments, the last on ${formatDate(option.lastPaymentDate)}, peaking at ${formatMoney(option.peakMonthlyOutflowMinor, currencyCode)} in a single month.`,
    );
  } else if (option.lastPaymentDate) {
    lines.push(`Paid in full on ${formatDate(option.lastPaymentDate)}.`);
  }

  if (option.rejections.includes("DEADLINE_EXCEEDED")) {
    lines.push("The last payment falls after the date this item is needed by.");
  }

  for (const impact of option.softReserveImpacts) {
    lines.push(`Eats ${formatMoney(impact.shortfallMinor, currencyCode)} into the “${impact.name}” goal.`);
  }

  lines.push(`Leaves ${formatMoney(option.safeToSpendAfterMinor, currencyCode)} safe to spend afterwards.`);
  return lines;
}

/**
 * The payment optimizer surface.
 *
 * Every figure here is rendered exactly as the engine returned it — nothing on
 * this page adds, divides or rounds money. When the engine declines to
 * recommend, that is shown as the answer, because saying "not enough to go on"
 * is more useful than a confident guess.
 */
export default async function PurchasePlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const [plan, creditCards] = await Promise.all([
    getPurchasePlan(user.id, id),
    listCreditCards(user.id),
  ]);
  if (!plan) notFound();
  const cardOptions = creditCards.map((card) => ({ id: card.id, name: card.name }));

  const [comparisons, planSimulationResult, baseline] = await Promise.all([
    Promise.all(
      plan.items.map(async (item) => ({
        item,
        result: await compareStoredPaymentOptions(user.id, item.id),
      })),
    ),
    getPurchasePlanSimulation(user.id, plan.id),
    buildUserForecastDetailed(user.id, PLAN_HORIZON_DAYS),
  ]);

  const planSimulation = planSimulationResult?.simulation;
  const unconfiguredItems = planSimulationResult?.unconfiguredItems ?? [];

  // Joined on the date, not the position — see the same reasoning that used
  // to live on the standalone /plan/simulate screen: two forecasts built by
  // separate calls each resolve "today" on their own, so a render across
  // midnight would shift one series against the other. Days without a
  // counterpart are dropped rather than defaulted.
  const baselineByDate = new Map(
    baseline.forecast.days.map((day) => [day.date, day.closingBalanceMinor]),
  );
  const planChartData = planSimulation
    ? planSimulation.forecastAfter.days.flatMap((day) => {
        const beforeMinor = baselineByDate.get(day.date);
        if (beforeMinor === undefined) return [];
        return [{ date: day.date, afterMinor: day.closingBalanceMinor, beforeMinor }];
      })
    : [];
  const monthlyEntries = planSimulation
    ? Object.entries(planSimulation.monthlyImpactMinor).sort(([a], [b]) => a.localeCompare(b))
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
          <NewPurchaseItemDialog purchasePlanId={plan.id} currencyCode={plan.currencyCode} />
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

      {unconfiguredItems.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground">
          <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
          <p>
            {unconfiguredItems.length} item{unconfiguredItems.length > 1 ? "s" : ""} still need
            {unconfiguredItems.length > 1 ? "" : "s"} a payment option chosen before the
            plan&apos;s verdict below can account for {unconfiguredItems.length > 1 ? "them" : "it"}:{" "}
            {unconfiguredItems.map((item) => item.name).join(", ")}.
          </p>
        </div>
      )}

      {planSimulation && (
        <section className="glass-panel space-y-5 rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <HugeiconsIcon
                icon={planSimulation.feasible ? CheckmarkCircle02Icon : Alert02Icon}
                className={cn("size-5", planSimulation.feasible ? "text-success" : "text-destructive")}
              />
              <h3 className="text-sm font-semibold">
                {planSimulation.feasible
                  ? plan.targetDate
                    ? `Fits, all of it, by ${formatDate(plan.targetDate)}`
                    : "Fits, all of it"
                  : "Does not fit as configured"}
              </h3>
            </div>
            <span className="font-amount text-sm tabular-nums text-muted-foreground">
              {formatMoney(planSimulation.totalCostMinor, plan.currencyCode)} total
            </span>
          </div>

          {!planSimulation.feasible && (
            <div className="flex flex-wrap gap-1.5">
              {planSimulation.rejections.map((code) => (
                <Badge key={code} variant="destructive" className="text-[10px]">
                  {REJECTION_LABEL[code] ?? code}
                </Badge>
              ))}
            </div>
          )}
          {planSimulation.reasons.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {planSimulation.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}

          <div className="grid gap-6 sm:grid-cols-2">
            <BeforeAfter
              label="Minimum balance"
              beforeMinor={planSimulation.minimumBalanceBeforeMinor}
              afterMinor={planSimulation.minimumBalanceAfterMinor}
              note={`on ${formatDate(planSimulation.minimumBalanceAfterDate)}`}
              currencyCode={plan.currencyCode}
            />
            <BeforeAfter
              label="Safe to spend"
              beforeMinor={planSimulation.safeToSpendBeforeMinor}
              afterMinor={planSimulation.safeToSpendAfterMinor}
              currencyCode={plan.currencyCode}
            />
          </div>

          <div>
            <span className="micro-label">Balance, vs without this plan</span>
            <div className="mt-3">
              <SimulationBalanceChart data={planChartData} currencyCode={plan.currencyCode} />
            </div>
          </div>

          {monthlyEntries.length > 0 && (
            <div>
              <span className="micro-label">Cash the plan adds, by month</span>
              <ul className="mt-2 divide-y divide-dashed">
                {monthlyEntries.map(([month, amountMinor]) => (
                  <li key={month} className="flex items-center justify-between py-1.5 text-xs first:pt-0 last:pb-0">
                    <span className="text-muted-foreground">{month}</span>
                    <span className="font-amount tabular-nums">
                      {formatMoney(amountMinor, plan.currencyCode)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {planSimulation.cards.length > 0 && (
            <div>
              <span className="micro-label">Card load</span>
              <ul className="mt-2 divide-y divide-dashed">
                {planSimulation.cards.map((card) => (
                  <li key={card.cardId} className="flex items-center justify-between gap-2 py-1.5 text-xs first:pt-0 last:pb-0">
                    <span>{card.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-amount tabular-nums text-muted-foreground">
                        {formatMoney(card.committedMinor + card.planChargedMinor, plan.currencyCode)}
                        {" / "}
                        {formatMoney(card.creditLimitMinor, plan.currencyCode)}
                      </span>
                      {card.exceededMinor > 0 && (
                        <Badge variant="destructive" className="text-[10px]">
                          +{formatMoney(card.exceededMinor, plan.currencyCode)} over
                        </Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {comparisons.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          Nothing in this plan yet. Add an item and its payment options to compare them here.
        </div>
      ) : (
        comparisons.map(({ item, result }) => {
          const comparison = result?.comparison;
          const recommendedId = comparison && "recommendedOptionId" in comparison ? comparison.recommendedOptionId : undefined;

          return (
            <section key={item.id} className="glass-panel rounded-2xl p-5">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">{item.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(
                      item.actualPriceMinor ?? item.estimatedPriceMinor,
                      plan.currencyCode,
                    )}
                    {item.actualPriceMinor !== null && " actually paid"}
                    {item.deadline ? ` · needed by ${formatDate(item.deadline)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {PRIORITY_LABEL[item.priority] ?? item.priority}
                  </Badge>
                  <PurchaseItemActions
                    item={{
                      id: item.id,
                      name: item.name,
                      priority: item.priority,
                      estimatedPriceMinor: item.estimatedPriceMinor,
                      actualPriceMinor: item.actualPriceMinor,
                      earliestPurchaseDate: item.earliestPurchaseDate,
                      deadline: item.deadline,
                      status: item.status,
                      notes: item.notes,
                    }}
                    currencyCode={plan.currencyCode}
                  />
                </div>
              </header>

              <PaymentOptionsSection
                purchaseItemId={item.id}
                currencyCode={plan.currencyCode}
                options={item.paymentOptions.map((option) => ({
                  id: option.id,
                  paymentMethod: option.paymentMethod,
                  cardId: option.cardId,
                  cashPriceMinor: option.cashPriceMinor,
                  installments: option.installments,
                  installmentAmountMinor: option.installmentAmountMinor,
                  totalCostMinor: option.totalCostMinor,
                  firstPaymentDate: option.firstPaymentDate,
                }))}
                cards={cardOptions}
                selectedPaymentOptionId={item.selectedPaymentOptionId}
              />

              {!comparison || comparison.status !== "OK" ? (
                <div className="mt-4 flex gap-2.5 rounded-xl bg-muted/50 p-4">
                  <HugeiconsIcon
                    icon={InformationCircleIcon}
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    strokeWidth={2}
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">
                      {comparison?.status === "NO_FEASIBLE_OPTION"
                        ? "No option works right now"
                        : "Not enough to compare yet"}
                    </p>
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {(comparison?.blockers ?? ["No payment option is registered for this item."]).map(
                        (blocker) => (
                          <li key={blocker}>{blocker}</li>
                        ),
                      )}
                    </ul>
                  </div>
                </div>
              ) : null}

              {comparison && comparison.options.length > 0 ? (
                <ul className="mt-4 space-y-3">
                  {comparison.options.map((option) => {
                    const recommended = option.id === recommendedId;
                    return (
                      <li
                        key={option.id}
                        className={cn(
                          "rounded-xl border p-4",
                          recommended ? "border-primary/40 bg-primary/5" : "border-border",
                          !option.feasible && "opacity-70",
                        )}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            {option.label}
                            {recommended && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                                <HugeiconsIcon
                                  icon={CheckmarkCircle02Icon}
                                  className="size-3.5"
                                  strokeWidth={2}
                                />
                                Recommended
                              </span>
                            )}
                          </span>
                          <span className="font-amount text-sm tabular-nums">
                            {formatMoney(option.totalCostMinor, plan.currencyCode)}
                          </span>
                        </div>

                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                          <div>
                            <dt className="text-muted-foreground">Lowest balance</dt>
                            <dd className="font-amount tabular-nums">
                              {formatMoney(option.minimumBalanceMinor, plan.currencyCode)}
                              <span className="ml-1 text-muted-foreground">
                                on {formatDate(option.minimumBalanceDate)}
                              </span>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Last payment</dt>
                            <dd>{option.lastPaymentDate ? formatDate(option.lastPaymentDate) : "—"}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Safe to spend after</dt>
                            <dd className="font-amount tabular-nums">
                              {formatMoney(option.safeToSpendAfterMinor, plan.currencyCode)}
                            </dd>
                          </div>
                        </dl>

                        {option.rejections.length > 0 && (
                          <ul className="mt-2 flex flex-wrap gap-1.5">
                            {option.rejections.map((rejection) => (
                              <li
                                key={rejection}
                                className="rounded-full bg-destructive/10 px-2 py-0.5 text-[0.625rem] font-medium text-destructive"
                              >
                                {REJECTION_LABEL[rejection] ?? rejection}
                              </li>
                            ))}
                          </ul>
                        )}

                        <details className="mt-2 group">
                          <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-2 hover:underline">
                            Why
                          </summary>
                          <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                            {explain(option, plan.currencyCode).map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        </details>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })
      )}
    </div>
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
