import { formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Safe-to-spend as a calm status, not an alarm. The number leads, a one-line
 * read names the state in plain words, and the arithmetic is one tap away
 * (native <details>) so the figure is never a black box. Tone is carried by a
 * soft tint and the word — red is reserved for genuinely over, never for
 * "a bit tight".
 *
 * The breakdown mirrors exactly what `getSafeToSpend` computed — the lowest
 * projected balance ahead, minus the protected reserve — rather than a
 * separate "earned minus spent" narrative. Showing any other equation here
 * would make the reveal lie about how the headline number was actually
 * derived, and the two would drift the moment they disagreed.
 */
export function SafeToSpendCard({
  safeMinor,
  minimumBalanceMinor,
  minimumBalanceDate,
  hardReserveMinor,
  hardReserveViolated,
  currency,
}: {
  safeMinor: number;
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
  hardReserveMinor: number;
  hardReserveViolated: boolean;
  currency: string;
}) {
  const over = hardReserveViolated;
  // How far the projected trough falls below the reserve — the deficit a
  // violated reserve represents, shown instead of a negative safe-to-spend
  // (which the engine never returns; it floors at 0).
  const deficitMinor = Math.max(0, hardReserveMinor - minimumBalanceMinor);
  // "Tight" once less than ~15% of the reserve is left as headroom — only
  // meaningful when a reserve is actually configured.
  const tight = !over && hardReserveMinor > 0 && safeMinor < hardReserveMinor * 0.15;

  const tone = over ? "over" : tight ? "tight" : "clear";
  const read = {
    over: "Projected to dip below your protected reserve — ease off where you can.",
    tight: "Running tight against your reserve. Worth slowing down on the extras.",
    clear: "You're clear. This is yours to spend or save.",
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
        {formatMoney(over ? deficitMinor : safeMinor, currency)}
        {over && <span className="ml-2 align-middle text-base font-normal text-destructive">short</span>}
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
            <Row label="Protected reserve" value={`− ${formatMoney(hardReserveMinor, currency)}`} />
          )}
          <Row label="Safe to spend" value={formatMoney(safeMinor, currency)} strong />
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
