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
  hardReserveViolated,
  bestRoute,
  routes,
  currency,
}: {
  safeMinor: number;
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
  floorMinor: number;
  hardReserveMinor: number;
  hardReserveViolated: boolean;
  bestRoute: SpendingRoute;
  routes: SpendingRoute[];
  currency: string;
}) {
  const over = hardReserveViolated;
  // "Tight" once less than ~15% of the reserve is left as headroom — only
  // meaningful when a reserve is actually configured.
  const tight = !over && hardReserveMinor > 0 && safeMinor < hardReserveMinor * 0.15;

  const tone = over ? "over" : tight ? "tight" : "clear";
  const read = {
    // The reserve being broken no longer blanks the figure. The amount is still
    // the answer to "what can I spend without being worse off than I am", which
    // is the question worth answering when you are already under water.
    over: `Already below your reserve — this is what you can spend on ${bestRoute.label} without going deeper.`,
    tight: "Running tight against your reserve. Worth slowing down on the extras.",
    clear: `Yours to spend. On ${bestRoute.label} it leaves on ${formatDate(bestRoute.settlementDate)}.`,
  }[tone];
  const accent = {
    over: "text-destructive",
    tight: "text-warning",
    clear: "text-foreground",
  }[tone];

  return (
    <div className="glass-panel rounded-2xl p-5 shadow-sm">
      <span className="micro-label">Safe to spend</span>
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
          <Row label="Floor this is measured to" value={formatMoney(floorMinor, currency)} />
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
