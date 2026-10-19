import { assertMinorUnits, assertValidDate, type DateString, type ForecastEvent } from "@hermes-finance/forecast";

/**
 * Money that takes up part of a card's limit from the day it is charged until
 * the statement that bills it is paid.
 *
 * A purchase in instalments is one charge per instalment, all charged on the
 * purchase day and each freed on its own statement's due date: the issuer
 * blocks the whole purchase at once and releases it as the statements are
 * paid.
 */
export interface CardCharge {
  cardId: string;
  chargedAt: DateString;
  settlesAt: DateString;
  /** Positive magnitude. */
  amountMinor: number;
}

/** A statement payment, which frees what the card already owes today. */
export interface CardDebtPayment {
  cardId: string;
  paidAt: DateString;
  /** Positive magnitude. */
  amountMinor: number;
}

/** What happens to the cards over the horizon before anything new is bought. */
export interface CardActivity {
  debtPayments: CardDebtPayment[];
  /** Charges still to come that the forecast already expects, e.g. budgeted spending on a card. */
  charges: CardCharge[];
}

export interface CardUsageInput {
  asOf: DateString;
  horizonEnd: DateString;
  /** Limit taken today. */
  committedMinor: number;
  debtPayments: CardDebtPayment[];
  charges: CardCharge[];
}

export interface CardUsagePeak {
  peakMinor: number;
  peakDate: DateString;
}

const STATEMENT_KEY = /^statement:(.+):\d{4}-\d{2}$/;

/**
 * Statement settlements in a forecast, as payments against each card's debt.
 *
 * `projectStatements` keys every settlement `statement:<cardId>:<YYYY-MM>`;
 * that key is the only place the card survives in a `ForecastEvent`.
 */
export function debtPaymentsFromForecast(events: ForecastEvent[]): CardDebtPayment[] {
  return events.flatMap((event) => {
    if (event.sourceType !== "card_statement" || event.amountMinor >= 0) return [];
    const match = STATEMENT_KEY.exec(event.logicalKey);
    if (!match) return [];
    return [{ cardId: match[1]!, paidAt: event.expectedAt, amountMinor: -event.amountMinor }];
  });
}

/**
 * The most of a card's limit in use on any day of the horizon, and when.
 *
 * Usage at the end of a day is what the card owes today less the statements
 * paid so far — never below zero, since a payment cannot free more than the
 * debt it settles — plus every charge made and not yet settled. It only rises
 * on a charge day, so those days and today are the only candidates for the
 * peak. A tie keeps the earliest day.
 */
export function peakCardUsage(input: CardUsageInput): CardUsagePeak {
  assertValidDate(input.asOf, "asOf");
  assertValidDate(input.horizonEnd, "horizonEnd");
  assertMinorUnits(input.committedMinor, "committedMinor");
  for (const payment of input.debtPayments) assertMinorUnits(payment.amountMinor, "debtPayments.amountMinor");
  for (const charge of input.charges) assertMinorUnits(charge.amountMinor, "charges.amountMinor");

  const chargedAt = (charge: CardCharge) => (charge.chargedAt < input.asOf ? input.asOf : charge.chargedAt);
  const candidates = [
    ...new Set([input.asOf, ...input.charges.map(chargedAt).filter((date) => date <= input.horizonEnd)]),
  ].sort();

  let peak: CardUsagePeak = { peakMinor: Number.NEGATIVE_INFINITY, peakDate: input.asOf };
  for (const day of candidates) {
    const paidMinor = input.debtPayments
      .filter((payment) => payment.paidAt <= day)
      .reduce((sum, payment) => sum + payment.amountMinor, 0);
    const openMinor = input.charges
      .filter((charge) => chargedAt(charge) <= day && charge.settlesAt > day)
      .reduce((sum, charge) => sum + charge.amountMinor, 0);
    const usageMinor = Math.max(0, input.committedMinor - paidMinor) + openMinor;
    if (usageMinor > peak.peakMinor) peak = { peakMinor: usageMinor, peakDate: day };
  }
  return peak;
}
