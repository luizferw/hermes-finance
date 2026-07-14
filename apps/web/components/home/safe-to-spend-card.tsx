import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Safe-to-spend as a calm status, not an alarm. The number leads, a one-line
 * read names the state in plain words, and the arithmetic is one tap away
 * (native <details>) so the figure is never a black box. Tone is carried by a
 * soft tint and the word — red is reserved for genuinely over, never for
 * "a bit tight".
 */
export function SafeToSpendCard({
  safeMinor,
  incomeMinor,
  expenseMinor,
  committedMinor,
  currency,
}: {
  safeMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  committedMinor: number;
  currency: string;
}) {
  const over = safeMinor < 0;
  // "Tight" once less than ~15% of income remains (only meaningful with income).
  const tight = !over && incomeMinor > 0 && safeMinor < incomeMinor * 0.15;

  const tone = over ? "over" : tight ? "tight" : "clear";
  const read = {
    over: "You're over for the month — ease off where you can.",
    tight: "Running tight. Worth slowing down on the extras.",
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
        {formatMoney(over ? -safeMinor : safeMinor, currency)}
        {over && <span className="ml-2 align-middle text-base font-normal text-destructive">over</span>}
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
          <Row label="Earned this month" value={formatMoney(incomeMinor, currency)} />
          <Row label="Spent" value={`− ${formatMoney(expenseMinor, currency)}`} />
          {committedMinor > 0 && (
            <Row label="Bills still due" value={`− ${formatMoney(committedMinor, currency)}`} />
          )}
          <Row
            label="Safe to spend"
            value={formatMoney(safeMinor, currency)}
            strong
          />
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
