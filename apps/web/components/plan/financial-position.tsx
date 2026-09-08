import type { FinancePosition } from "@/modules/finance/queries";
import { formatMoney } from "@/lib/format";

/**
 * The four numbers a financial standing is made of, held as one relationship:
 * what you have, what's already spoken for, what's yours to spend, and what
 * stays untouched. Same figure grid as the Future page's Horizon block, so
 * the vocabulary carries over.
 */
export function FinancialPositionSummary({
  position,
  safeToSpendMinor,
  committedMinor,
  hardReserveMinor,
  currency,
}: {
  position: FinancePosition;
  safeToSpendMinor: number;
  committedMinor: number;
  hardReserveMinor: number;
  currency: string;
}) {
  return (
    <div>
      <span className="micro-label">Your financial position</span>
      <dl className="mt-4 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
        <Figure label="Net balance" value={formatMoney(position.balanceMinor, currency)} />
        <Figure label="Committed" value={formatMoney(committedMinor, currency)} />
        <Figure label="Safe to spend" value={formatMoney(safeToSpendMinor, currency)} />
        <Figure label="Protected reserve" value={formatMoney(hardReserveMinor, currency)} />
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
