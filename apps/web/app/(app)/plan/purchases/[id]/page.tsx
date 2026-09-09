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
import {
  buildUserForecastDetailed,
  getPurchasePlanRecommendation,
  listCreditCards,
} from "@/modules/finance/queries";
import { compareStoredPaymentOptions } from "@/modules/finance/simulation";
import type {
  BlockedItem,
  MonthlyOutlookEntry,
  PurchasePlanRecommendation,
  PurchasePlanSimulation,
  RecommendedChoice,
} from "@hermes-finance/planning";
import { Badge } from "@/components/ui/badge";
import { SimulationBalanceChart } from "@/components/plan/simulation-balance-chart";
import { cn } from "@/lib/utils";
import { PurchaseItemActions } from "../item-actions";
import { NewPurchaseItemDialog } from "./new-item-dialog";
import { PaymentOptionsSection } from "./payment-options-section";
import { PurchasePlanActions } from "../plan-actions";
import { PlanTotalsLine } from "../plan-totals";

export const metadata: Metadata = { title: "Payment options" };

/** Matches the default horizon `getPurchasePlanRecommendation` uses internally. */
const PLAN_HORIZON_DAYS = 365;

const PRIORITY_LABEL: Record<string, string> = {
  must_have: "Must have",
  high: "High",
  medium: "Medium",
  low: "Low",
  optional: "Optional",
};

const STATUS_LABEL: Record<string, string> = {
  idea: "Idea",
  planned: "Planned",
  ready: "Ready",
  purchased: "Purchased",
  cancelled: "Cancelled",
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
 * The one-glance answer to "how is this being paid" — installment count and
 * size, the card it lands on, and when it starts and finishes. Every value
 * comes straight from the chosen `RecommendedChoice`; nothing here divides
 * `totalCostMinor` by `installments` — the engine already did that.
 */
function describeChoice(choice: RecommendedChoice, currencyCode: string): string {
  const payment =
    choice.installments > 1
      ? `${choice.installments}× ${formatMoney(choice.installmentAmountMinor, currencyCode)}`
      : `${formatMoney(choice.installmentAmountMinor, currencyCode)} in full`;
  const onCard = choice.cardLabel ? ` on ${choice.cardLabel}` : "";
  const span =
    choice.installments > 1 && choice.firstPaymentDate && choice.lastPaymentDate
      ? ` · ${formatDate(choice.firstPaymentDate)} → ${formatDate(choice.lastPaymentDate)}`
      : choice.lastPaymentDate
        ? ` · settled ${formatDate(choice.lastPaymentDate)}`
        : "";
  return `${payment}${onCard}${span}`;
}

/**
 * The purchase plan surface: a list to fill in, and the engine's answer for
 * how to pay for all of it.
 *
 * Every figure here is rendered exactly as the engine returned it — nothing on
 * this page adds, divides or rounds money, and nothing here picks a winner
 * among payment candidates. When the engine declines to recommend, that
 * refusal — and its reasons — is the answer, shown as-is rather than papered
 * over with a guess.
 */
export default async function PurchasePlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const [recommendationResult, creditCards, baseline] = await Promise.all([
    getPurchasePlanRecommendation(user.id, id),
    listCreditCards(user.id),
    buildUserForecastDetailed(user.id, PLAN_HORIZON_DAYS),
  ]);
  if (!recommendationResult) notFound();
  const { plan, recommendation, overriddenItemIds, hasCards } = recommendationResult;
  const cardOptions = creditCards.map((card) => ({ id: card.id, name: card.name }));

  // The manual, per-option comparison further down still reads from the
  // stored payment options — kept for whoever wants to inspect a specific
  // option rather than trust the recommendation outright.
  const comparisons = await Promise.all(
    plan.items.map(async (item) => ({
      item,
      result: await compareStoredPaymentOptions(user.id, item.id),
    })),
  );

  const simulation = recommendation?.status === "OK" ? recommendation.simulation : undefined;
  const choiceByItemId = new Map((recommendation?.choices ?? []).map((choice) => [choice.itemId, choice]));
  const overridden = new Set(overriddenItemIds);

  // Joined on the date, not the position — see the same reasoning that used
  // to live on the standalone /plan/simulate screen: two forecasts built by
  // separate calls each resolve "today" on their own, so a render across
  // midnight would shift one series against the other. Days without a
  // counterpart are dropped rather than defaulted.
  const baselineByDate = new Map(
    baseline.forecast.days.map((day) => [day.date, day.closingBalanceMinor]),
  );
  const planChartData = simulation
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

      {!hasCards && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground">
          <HugeiconsIcon icon={InformationCircleIcon} className="mt-0.5 size-4 shrink-0" />
          <p>
            No credit card is registered yet, so only paying in full is being considered. Register a
            card to get installment recommendations.
          </p>
        </div>
      )}

      {recommendation && (
        <RecommendationVerdict
          recommendation={recommendation}
          simulation={simulation}
          planChartData={planChartData}
          currencyCode={plan.currencyCode}
          targetDate={plan.targetDate}
        />
      )}

      {plan.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          Nothing in this plan yet. Add an item to get a recommendation for it.
        </div>
      ) : (
        comparisons.map(({ item, result }) => {
          const comparison = result?.comparison;
          const recommendedId = comparison && "recommendedOptionId" in comparison ? comparison.recommendedOptionId : undefined;
          const choice = choiceByItemId.get(item.id);
          const isDone = item.status === "purchased" || item.status === "cancelled";

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
                    {item.maxInstallments ? ` · up to ${item.maxInstallments}x` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {isDone ? STATUS_LABEL[item.status] : PRIORITY_LABEL[item.priority] ?? item.priority}
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
                      maxInstallments: item.maxInstallments,
                    }}
                    currencyCode={plan.currencyCode}
                  />
                </div>
              </header>

              {!isDone && choice && (
                <div className="mt-3">
                  <div
                      className={cn(
                        "rounded-xl border p-4",
                        overridden.has(item.id) ? "border-border bg-muted/40" : "border-primary/40 bg-primary/5",
                      )}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          {choice.optionLabel}
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 text-xs font-medium",
                              overridden.has(item.id) ? "text-muted-foreground" : "text-primary",
                            )}
                          >
                            <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-3.5" strokeWidth={2} />
                            {overridden.has(item.id) ? "Chosen by you" : "Recommended"}
                          </span>
                        </span>
                        <span className="font-amount text-sm tabular-nums">
                          {formatMoney(choice.totalCostMinor, plan.currencyCode)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {describeChoice(choice, plan.currencyCode)}
                      </p>
                      <details className="mt-2 group">
                        <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-2 hover:underline">
                          Why
                        </summary>
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          Leaves {formatMoney(choice.minimumBalanceMinor, plan.currencyCode)} on{" "}
                          {formatDate(choice.minimumBalanceDate)} — the most cash of the{" "}
                          {choice.workableCount} workable{" "}
                          {choice.workableCount === 1 ? "way" : "ways"} to pay for it.
                        </p>
                    </details>
                  </div>
                </div>
              )}

              <details className="mt-4 group">
                <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-2 hover:underline">
                  Manual options
                </summary>
                <div className="mt-2">
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
                        const isRecommended = option.id === recommendedId;
                        return (
                          <li
                            key={option.id}
                            className={cn(
                              "rounded-xl border p-4",
                              isRecommended ? "border-primary/40 bg-primary/5" : "border-border",
                              !option.feasible && "opacity-70",
                            )}
                          >
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                              <span className="flex items-center gap-1.5 text-sm font-medium">
                                {option.label}
                                {isRecommended && (
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
                </div>
              </details>
            </section>
          );
        })
      )}
    </div>
  );
}

/**
 * The engine's own `blockers` are audit prose in minor units — right for MCP
 * and the log, wrong for a screen, where they read as "-64381 on 2026-10-06".
 * This says the same thing from the structured fields, formatted.
 */
function describeBlock(blocked: BlockedItem, currencyCode: string): string {
  const parts: string[] = [];
  if (blocked.cappedCount > 0) {
    parts.push(`${blocked.cappedCount} need more than the ${blocked.maxInstallments}x it allows`);
  }
  if (blocked.lateCount > 0 && blocked.limitDate) {
    parts.push(`${blocked.lateCount} finish after ${formatDate(blocked.limitDate)}`);
  }
  if (blocked.overCardCount > 0) {
    parts.push(`${blocked.overCardCount} go past a card's remaining limit`);
  }
  if (blocked.belowFloorCount > 0 && blocked.bestFloorBreachMinor !== undefined) {
    parts.push(
      `${blocked.belowFloorCount} would leave ${formatMoney(blocked.bestFloorBreachMinor, currencyCode)}${blocked.bestFloorBreachDate ? ` on ${formatDate(blocked.bestFloorBreachDate)}` : ""}`,
    );
  }
  return parts.length > 0 ? `— ${parts.join(", ")}` : "— no way of paying it works";
}

function RecommendationVerdict({
  recommendation,
  simulation,
  planChartData,
  currencyCode,
  targetDate,
}: {
  recommendation: PurchasePlanRecommendation | undefined;
  simulation: PurchasePlanSimulation | undefined;
  planChartData: Array<{ date: string; afterMinor: number; beforeMinor: number }>;
  currencyCode: string;
  targetDate: string | null;
}) {
  if (!recommendation) return null;

  if (recommendation.status === "INSUFFICIENT_DATA") {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        <HugeiconsIcon icon={InformationCircleIcon} className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">Not enough to recommend yet</p>
          <p className="text-xs">
            Add what you want to buy — a name, a price and when you need it by —
            and this will tell you how to pay for all of it.
          </p>
        </div>
      </div>
    );
  }

  // NO_FEASIBLE_PLAN is the only status with nothing to show: no choice was
  // committed for every item, so there is no simulation to render alongside
  // the warning. An OK status can *also* carry a baselineBreach — the
  // recommender still answers under a "do not make it worse" rule — so that
  // case is handled below, together with the full plan.
  if (recommendation.status === "NO_FEASIBLE_PLAN") {
    const breach = recommendation.baselineBreach;
    return (
      <section className="glass-panel space-y-4 rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={Alert02Icon} className="size-5 text-destructive" />
          <h3 className="text-sm font-semibold">
            {breach ? "Your forecast is already short" : "This list does not fit"}
          </h3>
        </div>

        {breach ? (
          <div className="space-y-1 text-sm">
            <p>
              Before buying anything, your balance drops to{" "}
              <span className="font-amount tabular-nums text-destructive">
                {formatMoney(breach.minimumBalanceMinor, currencyCode)}
              </span>{" "}
              on {formatDate(breach.minimumBalanceDate)}.
            </p>
            <p className="text-xs text-muted-foreground">
              Nothing can be recommended against that. Record your accounts&apos; real
              balances, or cover that gap first, and this list will be answerable.
            </p>
          </div>
        ) : (
          recommendation.shortfallMinor !== undefined && (
            <p className="text-sm">
              Short by{" "}
              <span className="font-amount tabular-nums">
                {formatMoney(recommendation.shortfallMinor, currencyCode)}
              </span>
              {recommendation.shortfallDate ? ` around ${formatDate(recommendation.shortfallDate)}` : ""}.
            </p>
          )
        )}

        {recommendation.blockedItems.length > 0 && (
          <ul className="space-y-1.5 text-xs">
            {recommendation.blockedItems.map((blocked) => (
              <li key={blocked.itemId} className="flex flex-wrap gap-x-1.5">
                <span className="font-medium text-foreground">{blocked.label}</span>
                <span className="text-muted-foreground">
                  {describeBlock(blocked, currencyCode)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  // OK — the basket fits, and `simulation` is the verdict for the chosen set.
  if (!simulation) return null;
  const breach = recommendation.baselineBreach;

  return (
    <section className="glass-panel space-y-5 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={simulation.feasible ? CheckmarkCircle02Icon : Alert02Icon}
            className={cn("size-5", simulation.feasible ? "text-success" : "text-destructive")}
          />
          <h3 className="text-sm font-semibold">
            {simulation.feasible
              ? targetDate
                ? `Fits, all of it, by ${formatDate(targetDate)}`
                : "Fits, all of it"
              : "Does not fit as configured"}
          </h3>
        </div>
        <span className="font-amount text-sm tabular-nums text-muted-foreground">
          {formatMoney(simulation.totalCostMinor, currencyCode)} total
        </span>
      </div>

      {breach && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning-foreground">
          <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
          <p>
            Before buying anything, your balance already drops to{" "}
            <span className="font-amount tabular-nums">
              {formatMoney(breach.minimumBalanceMinor, currencyCode)}
            </span>{" "}
            on {formatDate(breach.minimumBalanceDate)}. This plan is chosen so as not to make that worse.
          </p>
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
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
      </div>

      {simulation.monthlyOutlook.length > 0 && (
        <div>
          <span className="micro-label">Month by month</span>
          <MonthlyOutlookTable entries={simulation.monthlyOutlook} currencyCode={currencyCode} />
        </div>
      )}

      <div>
        <span className="micro-label">Balance, vs without this plan</span>
        <div className="mt-3">
          <SimulationBalanceChart data={planChartData} currencyCode={currencyCode} />
        </div>
      </div>

      {simulation.cards.length > 0 && (
        <div>
          <span className="micro-label">Card load</span>
          <ul className="mt-2 divide-y divide-dashed">
            {simulation.cards.map((card) => (
              <li key={card.cardId} className="flex items-center justify-between gap-2 py-1.5 text-xs first:pt-0 last:pb-0">
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
                  <span className="ml-1 text-muted-foreground">
                    on {formatDate(entry.minimumBalanceDate)}
                  </span>
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
