/**
 * Ledger math. The conventions here are the contract between the database,
 * the modules layer, and the UI:
 *
 * - `amountMinor` on a transaction is signed from the perspective of its
 *   `accountId`: negative = money out, positive = money in.
 * - Transfers live on the source account (negative amount) and name the
 *   destination in `transferAccountId`; the destination side is derived.
 * - Splits must sum exactly to the transaction amount.
 */

export type TransactionType =
  | "income"
  | "expense"
  | "transfer"
  | "adjustment"
  | "opening_balance";

export type TransactionStatus =
  | "pending"
  | "imported"
  | "reviewed"
  | "posted"
  | "rejected";

/** Statuses that count toward balances and reports. */
export const LEDGER_STATUSES: readonly TransactionStatus[] = [
  "imported",
  "reviewed",
  "posted",
];

export interface LedgerEntry {
  accountId: string;
  transferAccountId?: string | null;
  type: TransactionType;
  status: TransactionStatus;
  amountMinor: number;
}

export function countsTowardLedger(status: TransactionStatus): boolean {
  return LEDGER_STATUSES.includes(status);
}

/**
 * Contribution of a transaction to a given account's balance.
 * Zero when the transaction is not in a ledger status or doesn't touch the
 * account. A transfer contributes `amount` to the source and `-amount` to
 * the destination (amount is negative for outgoing, so the destination
 * receives a positive delta).
 */
export function balanceDelta(entry: LedgerEntry, accountId: string): number {
  if (!countsTowardLedger(entry.status)) return 0;
  if (entry.accountId === accountId) return entry.amountMinor;
  if (entry.type === "transfer" && entry.transferAccountId === accountId) {
    return -entry.amountMinor;
  }
  return 0;
}

/** Expected sign for a transaction type, used by validation. */
export function expectedSign(type: TransactionType): -1 | 1 | 0 {
  switch (type) {
    case "expense":
    case "transfer":
      return -1;
    case "income":
      return 1;
    case "adjustment":
    case "opening_balance":
      return 0; // either direction
  }
}

export interface SplitInput {
  amountMinor: number;
  categoryId?: string | null;
}

export interface SplitValidation {
  ok: boolean;
  /** Difference between the transaction total and the sum of splits. */
  differenceMinor: number;
}

export function validateSplits(
  totalMinor: number,
  splits: SplitInput[],
): SplitValidation {
  const sum = splits.reduce((acc, s) => acc + s.amountMinor, 0);
  const differenceMinor = totalMinor - sum;
  return { ok: differenceMinor === 0 && splits.length > 0, differenceMinor };
}

export interface RunningBalancePoint {
  date: string;
  balanceMinor: number;
}

/**
 * Compute a daily running balance series for one account from its opening
 * balance and dated ledger entries. Entries outside ledger statuses are
 * ignored. Returns one point per day that has activity, in date order.
 */
export function runningBalances(
  accountId: string,
  openingBalanceMinor: number,
  entries: Array<LedgerEntry & { date: string }>,
): RunningBalancePoint[] {
  const byDate = new Map<string, number>();
  for (const entry of entries) {
    const delta = balanceDelta(entry, accountId);
    if (delta === 0) continue;
    byDate.set(entry.date, (byDate.get(entry.date) ?? 0) + delta);
  }
  const dates = [...byDate.keys()].sort();
  let balance = openingBalanceMinor;
  return dates.map((date) => {
    balance += byDate.get(date)!;
    return { date, balanceMinor: balance };
  });
}
