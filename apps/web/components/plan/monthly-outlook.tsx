import type { MonthOutlook } from "@/modules/finance/queries";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Where the balance lands over the next few months, one column per month.
 *
 * Two figures each, because they answer different questions. The closing
 * balance says how the month ends; the low says whether it can be lived
 * through. A month can close comfortably and still spend a week overdrawn, and
 * the worst day is routinely not the one the card statement falls on — so
 * showing only the close would hide the part worth acting on.
 *
 * A negative figure is stated, not softened. It is the number that says how much
 * is already booked against you.
 */
export function MonthlyOutlook({
  months,
  currency,
  locale,
}: {
  months: MonthOutlook[];
  currency: string;
  locale: string;
}) {
  if (months.length === 0) return null;

  return (
    <div>
      <span className="micro-label">Projected net balance</span>
      <dl
        className="mt-4 grid gap-x-8 gap-y-6 grid-cols-2 sm:grid-cols-4"
        aria-label="Projected balance by month"
      >
        {months.map((month) => (
          <div key={month.month} className="min-w-0">
            <dt className="micro-label flex items-center gap-1.5">
              {monthLabel(month.month, locale)}
              {month.isCurrentMonth && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
                  now
                </span>
              )}
            </dt>
            <dd
              className={cn(
                "mt-1.5 truncate font-amount text-2xl font-medium tracking-tight tabular-nums",
                month.closingBalanceMinor < 0 ? "text-destructive" : "text-foreground",
              )}
            >
              {formatMoney(month.closingBalanceMinor, currency, { locale })}
            </dd>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              low {formatMoney(month.lowMinor, currency, { locale })} ·{" "}
              {dayLabel(month.lowDate, locale)}
            </p>
          </div>
        ))}
      </dl>
    </div>
  );
}

function monthLabel(isoMonth: string, locale: string): string {
  const [year, month] = isoMonth.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1)).toLocaleDateString(locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayLabel(isoDay: string, locale: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
