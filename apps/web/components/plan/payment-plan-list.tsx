import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RecommendedChoice, RejectionCode } from "@hermes-finance/planning";

/**
 * "This item, paid how" in one line, straight from the fields the engine
 * already picked — nothing here divides `totalCostMinor` by `installments`
 * or otherwise recomputes what `recommendPurchasePlan` decided.
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

interface ChoiceGroup {
  key: string;
  label: string;
  choices: RecommendedChoice[];
}

/**
 * Cash first, then one group per card — so "what goes on the GOLD card" is
 * answerable by reading one heading, not by scanning every row's text.
 */
function groupChoices(choices: RecommendedChoice[]): ChoiceGroup[] {
  const cash: RecommendedChoice[] = [];
  const cardGroups = new Map<string, ChoiceGroup>();

  for (const choice of choices) {
    if (!choice.cardId) {
      cash.push(choice);
      continue;
    }
    const existing = cardGroups.get(choice.cardId);
    if (existing) {
      existing.choices.push(choice);
    } else {
      cardGroups.set(choice.cardId, {
        key: choice.cardId,
        label: choice.cardLabel ?? "Card",
        choices: [choice],
      });
    }
  }

  const groups: ChoiceGroup[] = [];
  if (cash.length > 0) {
    groups.push({ key: "cash", label: "Paid outright (cash / PIX)", choices: cash });
  }
  groups.push(...cardGroups.values());
  return groups;
}

/**
 * The list the purchase-plan page opens with: one row per item, grouped by
 * how it is paid. Everything rendered is a field the engine already
 * returned on `RecommendedChoice` — no summing, dividing or netting here.
 */
export function PaymentPlanList({
  choices,
  overriddenItemIds,
  currencyCode,
  rejectionLabel,
  assumeBought = false,
  planHref,
}: {
  choices: RecommendedChoice[];
  overriddenItemIds: Set<string>;
  currencyCode: string;
  rejectionLabel: Record<RejectionCode, string>;
  /** True when the balance floor is advisory rather than a veto. */
  assumeBought?: boolean;
  /** Where the toggle points — the same plan read the other way. */
  planHref?: string;
}) {
  if (choices.length === 0) return null;
  const groups = groupChoices(choices);

  return (
    <section className="glass-panel space-y-5 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Payment plan</h3>
        {planHref && (
          <Link
            href={planHref}
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {assumeBought ? "Only show what fits" : "Assume I buy it all anyway"}
          </Link>
        )}
      </div>
      {assumeBought && (
        <p className="text-xs text-muted-foreground">
          Answering as if these were already bought — the balance is allowed to
          go under, and what that costs is shown below. Card limits and
          deadlines are still respected; a bank still declines.
        </p>
      )}
      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.key}>
            <span className="micro-label">{group.label}</span>
            <ul className="mt-2 divide-y divide-dashed">
              {group.choices.map((choice) => (
                <li key={choice.itemId} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {choice.label}
                      {overriddenItemIds.has(choice.itemId) && (
                        <span className="text-xs font-normal text-muted-foreground">
                          (chosen by you)
                        </span>
                      )}
                      {!choice.fits && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                          <HugeiconsIcon icon={Alert02Icon} className="size-3.5" strokeWidth={2} />
                          Doesn&apos;t fit
                        </span>
                      )}
                    </span>
                    <span className="font-amount text-sm tabular-nums">
                      {formatMoney(choice.totalCostMinor, currencyCode)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {describeChoice(choice, currencyCode)}
                  </p>
                  {!choice.fits && choice.rejections.length > 0 && (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {choice.rejections.map((rejection) => (
                        <li
                          key={rejection}
                          className={cn(
                            "rounded-full bg-destructive/10 px-2 py-0.5 text-[0.625rem] font-medium text-destructive",
                          )}
                        >
                          {rejectionLabel[rejection] ?? rejection}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details className="mt-1.5 group">
                    <summary className="cursor-pointer list-none text-[0.7rem] text-muted-foreground underline-offset-2 hover:underline">
                      Why
                    </summary>
                    <p className="mt-1 text-[0.7rem] text-muted-foreground">
                      Leaves {formatMoney(choice.minimumBalanceMinor, currencyCode)} on{" "}
                      {formatDate(choice.minimumBalanceDate)} — the most cash of the{" "}
                      {choice.workableCount} workable {choice.workableCount === 1 ? "way" : "ways"}{" "}
                      to pay for it.
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
