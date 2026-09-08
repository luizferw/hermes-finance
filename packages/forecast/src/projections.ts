import {
  assertMinorUnits,
  assertValidDate,
  addDaysIso,
  addMonthsClampedIso,
  type Confidence,
  type DateString,
  type ForecastEvent,
} from "./forecast";

export interface DateRange {
  from: DateString;
  to: DateString;
}

export type RecurrenceInterval =
  | "daily"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "semiannual"
  | "yearly";

const intervalStep: Record<RecurrenceInterval, { days?: number; months?: number }> = {
  daily: { days: 1 },
  weekly: { days: 7 },
  biweekly: { days: 14 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  semiannual: { months: 6 },
  yearly: { months: 12 },
};

export interface RecurrenceRule {
  /** Stable identity of the rule, used to build each occurrence's logicalKey. */
  id: string;
  sourceType: string;
  /** Signed cash impact of one occurrence, in integer minor units. */
  amountMinor: number;
  interval: RecurrenceInterval;
  /** Date of the next (or first) occurrence to project. */
  startDate: DateString;
  /** Inclusive last date the rule may produce an occurrence on. */
  endDate?: DateString;
  confidence: Confidence;
}

function advance(date: DateString, interval: RecurrenceInterval, anchorDay: number): DateString {
  const step = intervalStep[interval];
  if (step.days !== undefined) return addDaysIso(date, step.days);
  return addMonthsClampedIso(date, step.months!, anchorDay);
}

/**
 * Expands recurrence rules into dated cash events inside a range.
 *
 * Each occurrence carries a `logicalKey` of `recurring:<ruleId>:<date>` so that a
 * confirmed bill or a real transaction for the same commitment can supersede it
 * through the confidence precedence in `buildForecast`.
 */
export function projectRecurrences(rules: RecurrenceRule[], range: DateRange): ForecastEvent[] {
  assertValidDate(range.from, "range.from");
  assertValidDate(range.to, "range.to");
  const events: ForecastEvent[] = [];

  for (const rule of rules) {
    assertValidDate(rule.startDate, `rule ${rule.id}.startDate`);
    assertMinorUnits(rule.amountMinor, `rule ${rule.id}.amountMinor`);
    if (rule.endDate) assertValidDate(rule.endDate, `rule ${rule.id}.endDate`);
    const anchorDay = Number(rule.startDate.slice(8, 10));
    const last = rule.endDate && rule.endDate < range.to ? rule.endDate : range.to;

    let date = rule.startDate;
    // Bounded by the range: a rule starting far in the past is fast-forwarded.
    let guard = 0;
    while (date <= last && guard < 10_000) {
      guard += 1;
      if (date >= range.from) {
        events.push({
          id: `recurring:${rule.id}:${date}`,
          logicalKey: `recurring:${rule.id}:${date}`,
          expectedAt: date,
          amountMinor: rule.amountMinor,
          sourceType: rule.sourceType,
          confidence: rule.confidence,
        });
      }
      const next = advance(date, rule.interval, anchorDay);
      if (next <= date) break;
      date = next;
    }
  }

  return events;
}

export interface InstallmentTail {
  number: number;
  amountMinor: number;
  /** Statement month (`YYYY-MM`) the installment is billed in. */
  statementMonth: string;
}

/**
 * Produces the remaining installments of a plan already partially billed.
 *
 * Reproduces the Entropy rule: an installment that already exists as a real fact
 * (`currentInstallmentNumber`) is never re-projected — only `N+1 … M` are.
 * The last installment absorbs any rounding remainder so the tail always sums to
 * the outstanding amount exactly.
 */
export function expandInstallmentTail(input: {
  totalInstallments: number;
  currentInstallmentNumber: number;
  installmentAmountMinor: number;
  /** Statement month (`YYYY-MM`) of `currentInstallmentNumber`. */
  currentStatementMonth: string;
  /** Total of the purchase, used to settle the final rounding remainder. */
  totalAmountMinor?: number;
}): InstallmentTail[] {
  const { totalInstallments, currentInstallmentNumber, installmentAmountMinor } = input;
  if (!Number.isInteger(totalInstallments) || totalInstallments < 1) {
    throw new Error("totalInstallments must be a positive integer");
  }
  if (!Number.isInteger(currentInstallmentNumber) || currentInstallmentNumber < 0) {
    throw new Error("currentInstallmentNumber must be a non-negative integer");
  }
  if (currentInstallmentNumber > totalInstallments) {
    throw new Error("currentInstallmentNumber must not exceed totalInstallments");
  }
  assertMinorUnits(installmentAmountMinor, "installmentAmountMinor");
  if (!/^\d{4}-\d{2}$/.test(input.currentStatementMonth)) {
    throw new Error("currentStatementMonth must be YYYY-MM");
  }

  const tail: InstallmentTail[] = [];
  for (let number = currentInstallmentNumber + 1; number <= totalInstallments; number += 1) {
    tail.push({
      number,
      amountMinor: installmentAmountMinor,
      statementMonth: addStatementMonths(input.currentStatementMonth, number - currentInstallmentNumber),
    });
  }

  if (input.totalAmountMinor !== undefined && tail.length > 0) {
    assertMinorUnits(input.totalAmountMinor, "totalAmountMinor");
    const alreadyBilled = installmentAmountMinor * currentInstallmentNumber;
    const outstanding = input.totalAmountMinor - alreadyBilled;
    const projected = installmentAmountMinor * tail.length;
    tail[tail.length - 1]!.amountMinor += outstanding - projected;
  }

  return tail;
}

export function addStatementMonths(statementMonth: string, months: number): string {
  const [year, month] = statementMonth.split("-").map(Number);
  const zeroBased = (year! * 12 + (month! - 1)) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = zeroBased - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

export interface BillingCycle {
  id: string;
  creditCardId: string;
  statementMonth: string;
  dueAt: DateString;
  /** Reconciled statement total in positive minor units, when the bill has arrived. */
  confirmedTotalMinor?: number;
  /** Set once the bill has been settled by a real transaction. */
  resolvedByTransactionId?: string;
}

export interface CycleCharge {
  /** Billing cycle the charge lands in. */
  billingCycleId: string;
  /** Positive magnitude in minor units. */
  amountMinor: number;
}

/**
 * Turns credit-card billing cycles into the single cash event each one produces.
 *
 * Card purchases and installments are economic expenses dated at purchase time;
 * the only cash movement is the statement settlement on `dueAt`. Emitting one
 * event per cycle — never one per installment — is what keeps R4 (purchase and
 * payment are different events) and R3 (never count twice) intact.
 */
export function projectStatements(cycles: BillingCycle[], charges: CycleCharge[], range: DateRange): ForecastEvent[] {
  assertValidDate(range.from, "range.from");
  assertValidDate(range.to, "range.to");

  const chargedByCycle = new Map<string, number>();
  for (const charge of charges) {
    assertMinorUnits(charge.amountMinor, "charge.amountMinor");
    chargedByCycle.set(charge.billingCycleId, (chargedByCycle.get(charge.billingCycleId) ?? 0) + charge.amountMinor);
  }

  const events: ForecastEvent[] = [];
  for (const cycle of cycles) {
    assertValidDate(cycle.dueAt, `cycle ${cycle.id}.dueAt`);
    if (cycle.dueAt < range.from || cycle.dueAt > range.to) continue;

    const confirmed = cycle.confirmedTotalMinor;
    if (confirmed !== undefined) assertMinorUnits(confirmed, `cycle ${cycle.id}.confirmedTotalMinor`);
    const totalMinor = confirmed ?? chargedByCycle.get(cycle.id) ?? 0;
    if (totalMinor === 0) continue;

    events.push({
      id: `statement:${cycle.id}`,
      logicalKey: `statement:${cycle.creditCardId}:${cycle.statementMonth}`,
      expectedAt: cycle.dueAt,
      amountMinor: -Math.abs(totalMinor),
      sourceType: "card_statement",
      confidence: confirmed !== undefined ? "CONFIRMED" : "HIGH",
      resolvedByTransactionId: cycle.resolvedByTransactionId,
    });
  }

  return events;
}

export interface NominalCycle {
  /** Statement month (`YYYY-MM`) the charge is billed in. */
  statementMonth: string;
  /** Last day the cycle accepts charges. */
  closesAt: DateString;
  /** Day the resulting bill must be paid. */
  dueAt: DateString;
}

function dayOfMonth(date: DateString): number {
  return Number(date.slice(8, 10));
}

function withDay(month: string, day: number): DateString {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/**
 * Finds the billing cycle a card charge falls into, from the card's nominal
 * closing and due days.
 *
 * A purchase made after the statement closes belongs to the next cycle — the
 * difference between buying on the 24th and the 26th is a whole month of float,
 * and getting it wrong misdates every installment that follows. Real
 * `CreditCardBillingCycle` rows should override this whenever they exist; this
 * is the fallback for cycles not yet observed.
 */
export function nominalCycleFor(purchaseDate: DateString, closingDay: number, dueDay: number): NominalCycle {
  assertValidDate(purchaseDate, "purchaseDate");
  if (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31) {
    throw new Error("closingDay must be an integer between 1 and 31");
  }
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new Error("dueDay must be an integer between 1 and 31");
  }

  const purchaseMonth = purchaseDate.slice(0, 7);
  // On the closing day itself the statement is still open.
  const statementMonth = dayOfMonth(purchaseDate) > closingDay ? addStatementMonths(purchaseMonth, 1) : purchaseMonth;
  const closesAt = withDay(statementMonth, closingDay);
  // A due day at or before the closing day means the bill is paid the month after it closes.
  const dueMonth = dueDay > closingDay ? statementMonth : addStatementMonths(statementMonth, 1);
  return { statementMonth, closesAt, dueAt: withDay(dueMonth, dueDay) };
}

/**
 * Due dates of the `count` consecutive statements starting with the one a
 * purchase falls into — the cash dates of an N-installment plan.
 */
export function nominalCycleDueDates(
  purchaseDate: DateString,
  closingDay: number,
  dueDay: number,
  count: number,
): DateString[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
  const first = nominalCycleFor(purchaseDate, closingDay, dueDay);
  const dueMonth = first.dueAt.slice(0, 7);
  return Array.from({ length: count }, (_unused, index) => withDay(addStatementMonths(dueMonth, index), dueDay));
}

export interface SettledFact {
  transactionId: string;
  logicalKey: string;
}

/**
 * Marks projections that a real transaction has already settled.
 *
 * `buildForecast` drops any event carrying `resolvedByTransactionId`, so this is
 * the seam where "the fact arrived" removes the corresponding forecast entry
 * instead of both being summed.
 */
export function resolveProjectedEvents(events: ForecastEvent[], facts: SettledFact[]): ForecastEvent[] {
  const byLogicalKey = new Map(facts.map((fact) => [fact.logicalKey, fact.transactionId]));
  return events.map((event) => {
    const transactionId = event.resolvedByTransactionId ?? byLogicalKey.get(event.logicalKey);
    return transactionId ? { ...event, resolvedByTransactionId: transactionId } : event;
  });
}
