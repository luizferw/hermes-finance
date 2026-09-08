export type Confidence = "ACTUAL" | "CONFIRMED" | "HIGH" | "MEDIUM" | "LOW";
export type DateString = string;

export interface BalanceSnapshot {
  accountId: string;
  amountMinor: number;
  observedAt: DateString;
}

export interface ForecastEvent {
  id: string;
  /** Stable identity for one economic commitment, e.g. `energy:2026-09`. */
  logicalKey: string;
  expectedAt: DateString;
  /** Signed cash impact in integer minor units. */
  amountMinor: number;
  sourceType: string;
  confidence: Confidence;
  resolvedByTransactionId?: string;
}

export interface ForecastDay {
  date: DateString;
  openingBalanceMinor: number;
  inflowsMinor: number;
  outflowsMinor: number;
  closingBalanceMinor: number;
  events: ForecastEvent[];
  confidenceBreakdown: Partial<Record<Confidence, number>>;
}

export interface Forecast {
  asOf: DateString;
  horizonEnd: DateString;
  openingBalanceMinor: number;
  days: ForecastDay[];
  events: ForecastEvent[];
  minimumBalanceMinor: number;
  minimumBalanceDate: DateString;
}

export interface BuildForecastInput {
  asOf: DateString;
  horizonEnd: DateString;
  balances: BalanceSnapshot[];
  events: ForecastEvent[];
}

const confidenceRank: Record<Confidence, number> = {
  ACTUAL: 5,
  CONFIRMED: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function utcDate(value: DateString): Date {
  assertIsoDate(value, "date");
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function assertIsoDate(value: string, label: string): asserts value is DateString {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be a valid ISO date (YYYY-MM-DD)`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (Number.isNaN(parsed.getTime()) || dateString(parsed) !== value) {
    throw new Error(`${label} must be a valid ISO date (YYYY-MM-DD)`);
  }
}

export function assertMinorUnits(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must use finite integer minor units`);
  }
}

/**
 * Non-asserting date guard for callers outside this module. TypeScript forbids
 * calling an imported `asserts` signature without an explicit type annotation,
 * so the projection helpers use this plain form instead.
 */
export function assertValidDate(value: string, label: string): void {
  assertIsoDate(value, label);
}

/** Adds whole days to an ISO date, in UTC. */
export function addDaysIso(value: DateString, days: number): DateString {
  const next = utcDate(value);
  next.setUTCDate(next.getUTCDate() + days);
  return dateString(next);
}

/**
 * Adds whole months, clamping to the last valid day of the target month and
 * re-anchoring on `anchorDay` so a 31st-of-the-month rule does not drift to the
 * 28th permanently after passing through February.
 */
export function addMonthsClampedIso(value: DateString, months: number, anchorDay?: number): DateString {
  assertIsoDate(value, "date");
  const [year, month, day] = value.split("-").map(Number);
  const target = anchorDay ?? day!;
  const zeroBased = year! * 12 + (month! - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = zeroBased - nextYear * 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  return dateString(new Date(Date.UTC(nextYear, nextMonth, Math.min(target, lastDay))));
}

function validateInput(input: BuildForecastInput): void {
  assertIsoDate(input.asOf, "asOf");
  assertIsoDate(input.horizonEnd, "horizonEnd");
  for (const balance of input.balances) {
    assertIsoDate(balance.observedAt, "balance.observedAt");
    assertMinorUnits(balance.amountMinor, "balance.amountMinor");
    if (balance.observedAt !== input.asOf) {
      throw new Error("balance.observedAt must equal asOf; normalize snapshots before forecasting");
    }
  }
  for (const event of input.events) {
    assertIsoDate(event.expectedAt, "event.expectedAt");
    assertMinorUnits(event.amountMinor, "event.amountMinor");
    if (event.logicalKey.length === 0) throw new Error("event.logicalKey must not be empty");
    if (!(event.confidence in confidenceRank)) throw new Error("event.confidence is invalid");
  }
}

function dateString(value: Date): DateString {
  return value.toISOString().slice(0, 10) as DateString;
}

function nextDate(value: DateString): DateString {
  const next = utcDate(value);
  next.setUTCDate(next.getUTCDate() + 1);
  return dateString(next);
}

function selectActiveEvents(events: ForecastEvent[]): ForecastEvent[] {
  const bestByLogicalKey = new Map<string, ForecastEvent>();
  for (const event of events) {
    if (event.resolvedByTransactionId) continue;
    const existing = bestByLogicalKey.get(event.logicalKey);
    if (
      !existing ||
      confidenceRank[event.confidence] > confidenceRank[existing.confidence] ||
      (confidenceRank[event.confidence] === confidenceRank[existing.confidence] && event.id < existing.id)
    ) {
      bestByLogicalKey.set(event.logicalKey, event);
    }
  }
  return [...bestByLogicalKey.values()].sort((left, right) =>
    left.expectedAt.localeCompare(right.expectedAt) || left.id.localeCompare(right.id),
  );
}

/**
 * Builds a reproducible consolidated cash forecast. It accepts only normalized,
 * integer-minor-unit facts and projections; persistence and UI stay outside this
 * boundary. For a shared logical commitment, the highest-confidence event wins.
 */
export function buildForecast(input: BuildForecastInput): Forecast {
  validateInput(input);
  if (input.horizonEnd < input.asOf) {
    throw new Error("horizonEnd must be on or after asOf");
  }

  const events = selectActiveEvents(input.events).filter(
    (event) => event.expectedAt >= input.asOf && event.expectedAt <= input.horizonEnd,
  );
  const eventsByDate = new Map<DateString, ForecastEvent[]>();
  for (const event of events) {
    const onDate = eventsByDate.get(event.expectedAt) ?? [];
    onDate.push(event);
    eventsByDate.set(event.expectedAt, onDate);
  }

  const openingBalanceMinor = input.balances.reduce((total, balance) => total + balance.amountMinor, 0);
  let runningBalance = openingBalanceMinor;
  /**
   * The trough is taken over daily *closing* balances only.
   *
   * The opening figure is the balance before any of today's movements, and it
   * is not a level the projection has to protect: money spent today leaves from
   * it. Including it would understate safe-to-spend whenever the balance climbs
   * during the first day, and would also disagree with the chart, which plots
   * closing balances.
   */
  let minimumBalanceMinor = Number.POSITIVE_INFINITY;
  let minimumBalanceDate = input.asOf;
  const days: ForecastDay[] = [];

  for (let date = input.asOf; date <= input.horizonEnd; date = nextDate(date)) {
    const dayEvents = eventsByDate.get(date) ?? [];
    const inflowsMinor = dayEvents
      .filter((event) => event.amountMinor > 0)
      .reduce((total, event) => total + event.amountMinor, 0);
    const outflowsMinor = dayEvents
      .filter((event) => event.amountMinor < 0)
      .reduce((total, event) => total + -event.amountMinor, 0);
    const confidenceBreakdown: Partial<Record<Confidence, number>> = {};
    for (const event of dayEvents) {
      confidenceBreakdown[event.confidence] = (confidenceBreakdown[event.confidence] ?? 0) + Math.abs(event.amountMinor);
    }

    const opening = runningBalance;
    runningBalance += inflowsMinor - outflowsMinor;
    if (runningBalance < minimumBalanceMinor) {
      minimumBalanceMinor = runningBalance;
      minimumBalanceDate = date;
    }
    days.push({
      date,
      openingBalanceMinor: opening,
      inflowsMinor,
      outflowsMinor,
      closingBalanceMinor: runningBalance,
      events: dayEvents,
      confidenceBreakdown,
    });
  }

  return {
    asOf: input.asOf,
    horizonEnd: input.horizonEnd,
    openingBalanceMinor,
    days,
    events,
    minimumBalanceMinor,
    minimumBalanceDate,
  };
}
