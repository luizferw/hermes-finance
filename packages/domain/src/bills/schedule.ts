import {
  addInterval,
  todayIso,
  daysBetween,
  type RecurrenceInterval,
} from "../shared/dates";

export interface BillLike {
  nextDueDate: string;
  recurrence: RecurrenceInterval;
  isActive: boolean;
}

export type BillState = "overdue" | "due_soon" | "upcoming" | "inactive";

export function billState(bill: BillLike, today = todayIso()): BillState {
  if (!bill.isActive) return "inactive";
  if (bill.nextDueDate < today) return "overdue";
  if (daysBetween(today, bill.nextDueDate) <= 7) return "due_soon";
  return "upcoming";
}

/** Roll the due date forward until it is >= today (used after marking paid). */
export function rollDueDateForward(bill: BillLike, today = todayIso()): string {
  let next = bill.nextDueDate;
  while (next < today) {
    next = addInterval(next, bill.recurrence);
  }
  return next;
}

/** Advance exactly one period (used when the current cycle is paid). */
export function advanceOnePeriod(bill: BillLike): string {
  return addInterval(bill.nextDueDate, bill.recurrence);
}

/**
 * Does a transaction look like a payment for this bill? Same direction
 * (outflow), amount within `tolerance` (default 15%), date within ±10 days
 * of the due date.
 */
export function matchesBillPayment(
  bill: { expectedAmountMinor: number; nextDueDate: string },
  tx: { amountMinor: number; date: string },
  tolerance = 0.15,
): boolean {
  if (tx.amountMinor >= 0) return false;
  const paid = Math.abs(tx.amountMinor);
  const expected = Math.abs(bill.expectedAmountMinor);
  if (expected === 0) return false;
  const withinAmount = Math.abs(paid - expected) / expected <= tolerance;
  const withinDate = Math.abs(daysBetween(bill.nextDueDate, tx.date)) <= 10;
  return withinAmount && withinDate;
}
