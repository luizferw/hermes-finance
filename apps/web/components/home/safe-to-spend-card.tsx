import { formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Safe-to-spend as a calm status, not an alarm. The number leads, a one-line
 * read names the state in plain words, and the arithmetic is one tap away
 * (native <details>) so the figure is never a black box.
 *
 * The figure is route-dependent and says so. Cash spent today has to survive
 * every dip between now and the horizon; the same amount on a card leaves on
 * that card's due date and only has to survive what comes after it. Printing the
 * amount without naming the route and the date would be printing a number the
 * reader cannot act on.
 *
 * The breakdown mirrors exactly what `getSafeToSpend` computed rather than a
 * separate "earned minus spent" narrative, which would drift from the headline
 * the moment the two disagreed.
 */
export interface SpendingRoute {
  label: string;
  settlementDate: string;
  amountMinor: number;
}

export function SafeToSpendCard({
  safeMinor,
  minimumBalanceMinor,
  minimumBalanceDate,
  floorMinor,
  hardReserveMinor,
  bestRoute,
  routes,
  currency,
}: {
  safeMinor: number;
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
  floorMinor: number;
  hardReserveMinor: number;
  bestRoute: SpendingRoute;
  routes: SpendingRoute[];
  currency: string;
}) {
  // A negative figure is the informative case, not an error state: next month
  // lands that far under before anything new is bought.
  const short = safeMinor < 0;
  const tight = !short && hardReserveMinor > 0 && safeMinor < hardReserveMinor * 0.15;

  const tone = short ? "over" : tight ? "tight" : "clear";
  const read = short
    ? `Next month already lands ${formatMoney(-safeMinor, currency)} short. Spending anything now deepens it.`
    : tight
      ? "Running tight against your reserve. Worth slowing down on the extras."
      : `Spend this on ${bestRoute.label} and next month still lands on zero. It leaves on ${formatDate(bestRoute.settlementDate)}.`;
  const accent = {
    over: "text-destructive",
    tight: "text-warning",
    clear: "text-foreground",
  }[tone];

  return (
    <div className="glass-panel rounded-2xl p-5 shadow-sm">
      <span className="micro-label">Room to spend</span>
      <p
        className={cn(
          "mt-1.5 font-amount text-[clamp(2rem,5vw,2.75rem)] leading-[0.95] font-medium tracking-[-0.03em] tabular-nums",
          accent,
        )}
      >
        {formatMoney(safeMinor, currency)}
      </p>
      <p className="mt-2 max-w-[40ch] text-sm text-muted-foreground">{read}</p>

      <details className="group mt-3">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          How this is worked out
          <span aria-hidden className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <dl className="mt-2.5 space-y-1.5 border-t border-border/60 pt-2.5 text-sm">
          <Row
            label={`Lowest projected balance · ${formatDate(minimumBalanceDate)}`}
            value={formatMoney(minimumBalanceMinor, currency)}
          />
          {hardReserveMinor > 0 && (
            <Row label="Protected reserve" value={formatMoney(hardReserveMinor, currency)} />
          )}
          <Row label="Floor it lands on" value={formatMoney(floorMinor, currency)} />
          {routes.map((route) => (
            <Row
              key={route.label}
              label={`${route.label} · leaves ${formatDate(route.settlementDate)}`}
              value={formatMoney(route.amountMinor, currency)}
              strong={route.label === bestRoute.label}
            />
          ))}
        </dl>
      </details>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4",
        strong && "border-t border-border/60 pt-1.5 font-medium text-foreground",
      )}
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-amount tabular-nums">{value}</dd>
    </div>
  );
}
