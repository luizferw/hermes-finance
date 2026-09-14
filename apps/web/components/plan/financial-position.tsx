import type { FinancePosition } from "@/modules/finance/queries";
import { formatMoney } from "@/lib/format";

/**
 * What you have right now, and how fresh that number is.
 *
 * It used to also carry safe-to-spend and the protected reserve. Those said what
 * is left after the future is accounted for, which the month-by-month projection
 * beneath it now answers directly and per month — two summaries of the same
 * future, side by side, invite the reader to reconcile them.
 */
export function FinancialPositionSummary({
  position,
  currency,
}: {
  position: FinancePosition;
  currency: string;
}) {
  return (
    <div>
      <span className="micro-label">Your financial position</span>
      <dl className="mt-4 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-6">
        <Figure label="Net balance" value={formatMoney(position.balanceMinor, currency)} />
      </dl>
      <Freshness position={position} />
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label">{label}</dt>
      <dd className="mt-1.5 truncate font-amount text-2xl font-medium tracking-tight text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/**
 * Staleness is informational, never an alarm (PRD R8/§62) — a calm aside
 * naming which accounts fed the calculation with an older balance, and how
 * old, so the figure above is never a black box.
 */
function Freshness({ position }: { position: FinancePosition }) {
  if (position.staleAccountNames.length === 0) return null;
  const stale = position.accounts.filter((account) => account.isStale);

  return (
    <p className="mt-4 max-w-2xl text-xs text-muted-foreground">
      This uses a balance that&apos;s a few days old for{" "}
      {stale.map((account, i) => (
        <span key={account.id}>
          {i > 0 && (i === stale.length - 1 ? " and " : ", ")}
          <span className="font-medium text-foreground/80">{account.name}</span>{" "}
          <span className="font-amount tabular-nums">
            (updated {account.ageDays} {account.ageDays === 1 ? "day" : "days"} ago)
          </span>
        </span>
      ))}
      .
    </p>
  );
}
