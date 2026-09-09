import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Calculator01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { majorToMinor } from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { formatDate, formatMoney } from "@/lib/format";
import { getUserSettings } from "@/modules/settings/queries";
import { buildUserForecastDetailed, listCreditCards } from "@/modules/finance/queries";
import { simulateUserPurchase, type PurchaseOptionInput } from "@/modules/finance/simulation";
import { simulatePurchaseParamsSchema } from "@/modules/finance/validators";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SimulationBalanceChart } from "@/components/plan/simulation-balance-chart";
import { cn } from "@/lib/utils";
import { SimulateForm } from "./simulate-form";

export const metadata: Metadata = { title: "Simulate a purchase" };

const REJECTION_LABEL: Record<string, string> = {
  HARD_RESERVE_VIOLATED: "Breaks protected reserve",
  NEGATIVE_BALANCE: "Drives balance below zero",
  CREDIT_LIMIT_EXCEEDED: "Exceeds card limit",
  DEADLINE_EXCEEDED: "Finishes after the needed-by date",
};

/** Matches the default horizon `simulateUserPurchase` uses when none is given. */
const HORIZON_DAYS = 365;

interface SimulateSearchParams {
  method?: string;
  amount?: string;
  purchaseDate?: string;
  cardId?: string;
  installments?: string;
  neededBy?: string;
}

/**
 * Ad-hoc "what if I bought this?" screen. It has no persistence — the whole
 * page is derived from the query string, so a simulation is just a URL.
 * Every figure rendered here is the engine's; the page only formats it
 * (PRD R6).
 */
export default async function SimulatePurchasePage({
  searchParams,
}: {
  searchParams: Promise<SimulateSearchParams>;
}) {
  const user = await requireUser();
  const [settings, creditCards, params] = await Promise.all([
    getUserSettings(user.id),
    listCreditCards(user.id),
    searchParams,
  ]);
  const currencyCode = settings.currencyCode;
  const cardOptions = creditCards.map((card) => ({ id: card.id, name: card.name }));

  if (!params.amount) {
    return (
      <div className="space-y-6">
        <SimulateForm currencyCode={currencyCode} cards={cardOptions} initial={params} />
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Calculator01Icon} />
            </EmptyMedia>
            <EmptyTitle>See how a purchase lands before you make it</EmptyTitle>
            <EmptyDescription>
              Enter an amount, a payment method, and — for a card — installments. The engine
              runs it against your real forecast and shows what it does to your low point,
              your safe-to-spend, and your reserves.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const parsed = simulatePurchaseParamsSchema.safeParse(params);
  if (!parsed.success) {
    return (
      <div className="space-y-6">
        <SimulateForm currencyCode={currencyCode} cards={cardOptions} initial={params} />
        <div className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">
          {parsed.error.issues.map((issue) => (
            <p key={issue.path.join(".")}>{issue.message}</p>
          ))}
        </div>
      </div>
    );
  }

  const input = parsed.data;
  const option: PurchaseOptionInput = {
    id: "simulation",
    method: input.method,
    amountMinor: majorToMinor(input.amount, currencyCode),
    cardId: input.cardId ?? null,
    installments: input.installments ?? null,
    purchaseDate: input.purchaseDate ?? null,
  };

  const [simulation, baseline] = await Promise.all([
    simulateUserPurchase(user.id, option, {
      horizonDays: HORIZON_DAYS,
      maxLastPaymentDate: input.neededBy ?? undefined,
    }),
    buildUserForecastDetailed(user.id, HORIZON_DAYS),
  ]);

  // Joined on the date, not the position. The two forecasts are built by
  // separate calls that each resolve "today" on their own, so a render across
  // midnight would shift one series against the other. Days without a
  // counterpart are dropped rather than defaulted: a missing baseline drawn as
  // the after value would render the two lines identical, which reads as "this
  // purchase changes nothing" — the one conclusion a broken chart must never
  // state.
  const baselineByDate = new Map(
    baseline.forecast.days.map((day) => [day.date, day.closingBalanceMinor]),
  );
  const chartData = simulation.forecastAfter.days.flatMap((day) => {
    const beforeMinor = baselineByDate.get(day.date);
    if (beforeMinor === undefined) return [];
    return [{ date: day.date, afterMinor: day.closingBalanceMinor, beforeMinor }];
  });

  const monthlyEntries = Object.entries(simulation.monthlyImpactMinor).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <div className="space-y-6">
      <SimulateForm currencyCode={currencyCode} cards={cardOptions} initial={params} />

      <section className="glass-panel rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={simulation.feasible ? CheckmarkCircle02Icon : Alert02Icon}
            className={cn("size-5 shrink-0", simulation.feasible ? "text-success" : "text-destructive")}
            strokeWidth={2}
          />
          <h2 className="text-sm font-semibold">
            {simulation.feasible ? "This fits" : "This does not fit"}
          </h2>
        </div>

        {simulation.rejections.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
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

        {simulation.reasons.length > 0 && (
          <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
            {simulation.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="glass-panel rounded-2xl p-5">
        <span className="micro-label">Balance, with vs without this purchase</span>
        <div className="mt-3">
          <SimulationBalanceChart data={chartData} currencyCode={currencyCode} />
        </div>
      </section>

      <section className="glass-panel grid gap-6 rounded-2xl p-5 sm:grid-cols-2">
        <BeforeAfter
          label="Minimum balance"
          beforeMinor={simulation.minimumBalanceBeforeMinor}
          afterMinor={simulation.minimumBalanceAfterMinor}
          note={`on ${formatDate(simulation.minimumBalanceDateAfter)}`}
          currencyCode={currencyCode}
        />
        <BeforeAfter
          label="Safe to spend"
          beforeMinor={simulation.safeToSpendBeforeMinor}
          afterMinor={simulation.safeToSpendAfterMinor}
          currencyCode={currencyCode}
        />
      </section>

      <section className="glass-panel grid gap-4 rounded-2xl p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Immediate impact" value={formatMoney(simulation.immediateImpactMinor, currencyCode)} />
        <Figure label="Total cost" value={formatMoney(simulation.totalCostMinor, currencyCode)} />
        <Figure label="Installments" value={String(simulation.installments)} />
        <Figure
          label="Last payment"
          value={simulation.lastPaymentDate ? formatDate(simulation.lastPaymentDate) : "—"}
        />
      </section>

      {(simulation.softReserveImpacts.length > 0 ||
        simulation.creditLimitExceededMinor != null ||
        simulation.cardUtilizationAfterMinor != null) && (
        <section className="glass-panel space-y-3 rounded-2xl p-5">
          {simulation.softReserveImpacts.length > 0 && (
            <div>
              <span className="micro-label">Reserve impact</span>
              <ul className="mt-2 space-y-1 text-sm">
                {simulation.softReserveImpacts.map((impact) => (
                  <li key={impact.id} className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{impact.name}</span>
                    <span className="font-amount tabular-nums text-destructive">
                      -{formatMoney(impact.shortfallMinor, currencyCode)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {simulation.creditLimitExceededMinor != null && (
            <p className="text-sm text-destructive">
              Exceeds the card&apos;s limit by {formatMoney(simulation.creditLimitExceededMinor, currencyCode)}
            </p>
          )}
          {simulation.cardUtilizationAfterMinor != null && (
            <p className="text-sm text-muted-foreground">
              Card utilization after this purchase:{" "}
              {formatMoney(simulation.cardUtilizationAfterMinor, currencyCode)}
            </p>
          )}
        </section>
      )}

      {monthlyEntries.length > 0 && (
        <section className="glass-panel rounded-2xl p-5">
          <span className="micro-label">Monthly cash impact</span>
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {monthlyEntries.map(([month, minor]) => (
              <div key={month}>
                <dt className="text-xs text-muted-foreground">{month}</dt>
                <dd className="font-amount text-sm tabular-nums">{formatMoney(minor, currencyCode)}</dd>
              </div>
            ))}
          </dl>
        </section>
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

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="micro-label">{label}</dt>
      <dd className="mt-1.5 font-amount text-lg font-medium tabular-nums">{value}</dd>
    </div>
  );
}
