/**
 * Recognising a bank outflow as the settlement of a card bill.
 *
 * A card purchase and the payment of its statement are different events: the
 * purchase is an economic expense dated at the purchase, the payment is a
 * cash-flow event that must not become a second categorized expense (PRD R4).
 * Between two of your own accounts it is a transfer, and a transfer nets to zero
 * across the consolidated position (R5).
 *
 * Only the bank side is ever stored. `deriveLedgerCycles` in the finance module
 * already reads it that way — "a transfer is one row on the source account, its
 * destination leg is derived, never stored" — so pairing means pointing the
 * existing bank row at the card, not inventing a second row.
 *
 * Pure, because the rule that decides is the part worth testing: a wrong pairing
 * moves money between two real accounts.
 */

/** A bill payment seen on the card side and deliberately not booked there. */
export interface CardPaymentLeg {
  /**
   * Identifies this leg to the caller, so a match can say which one it consumed.
   *
   * Without it the caller has to find the leg again from the decision, and the
   * only key it has is amount plus date — which is wrong by construction here,
   * because the window exists precisely so the two legs may differ by a day.
   */
  id: string;
  /** The Hermes account id of the card. */
  cardAccountId: string;
  date: string;
  /** Positive magnitude. */
  amountMinor: number;
}

/** A bank outflow that looks like it settles a card bill. */
export interface BankOutflow {
  transactionId: string;
  date: string;
  /** Negative, as stored in the ledger. */
  amountMinor: number;
}

export type CardPaymentMatch =
  | { kind: "matched"; transactionId: string; cardAccountId: string; legId: string }
  | { kind: "ambiguous"; transactionId: string; cardAccountIds: string[] }
  | { kind: "unmatched"; transactionId: string };

/**
 * How far apart the two legs may be.
 *
 * A bill paid by transfer clears the card the same day or the next; a couple of
 * days covers a weekend. Widening this buys very little and starts pulling in
 * unrelated payments of coincidentally equal value.
 */
export const CARD_PAYMENT_WINDOW_DAYS = 2;

function daysApart(left: string, right: string): number {
  const a = Date.parse(`${left}T00:00:00.000Z`);
  const b = Date.parse(`${right}T00:00:00.000Z`);
  return Math.abs(a - b) / 86_400_000;
}

/**
 * Point one bank outflow at the card whose bill it paid.
 *
 * The amount has to match exactly — this is the same money seen from both sides,
 * not an approximation — and the dates have to be close. More than one card
 * answering that description is not resolved: PRD §14 forbids choosing
 * arbitrarily between plausible matches, so it is reported for a human instead.
 */
export function matchCardPayment(
  outflow: BankOutflow,
  legs: readonly CardPaymentLeg[],
): CardPaymentMatch {
  const wanted = Math.abs(outflow.amountMinor);
  const candidates = legs.filter(
    (leg) =>
      leg.amountMinor === wanted && daysApart(leg.date, outflow.date) <= CARD_PAYMENT_WINDOW_DAYS,
  );

  const cardAccountIds = [...new Set(candidates.map((leg) => leg.cardAccountId))];
  if (cardAccountIds.length === 1) {
    const chosen = [...candidates].sort(
      (left, right) => daysApart(left.date, outflow.date) - daysApart(right.date, outflow.date),
    )[0]!;
    return {
      kind: "matched",
      transactionId: outflow.transactionId,
      cardAccountId: cardAccountIds[0]!,
      legId: chosen.id,
    };
  }
  if (cardAccountIds.length > 1) {
    return { kind: "ambiguous", transactionId: outflow.transactionId, cardAccountIds };
  }
  return { kind: "unmatched", transactionId: outflow.transactionId };
}

/**
 * Match a batch, never letting one payment settle two bills.
 *
 * Two statements of the same value in the same week is ordinary — two cards with
 * the same minimum payment, say. Each leg is therefore consumed once, closest
 * date first, so a second outflow cannot claim a leg an earlier one already used
 * and silently credit the same card twice.
 */
export function matchCardPayments(
  outflows: readonly BankOutflow[],
  legs: readonly CardPaymentLeg[],
): CardPaymentMatch[] {
  const available = legs.map((leg) => ({ leg, used: false }));
  const ordered = [...outflows].sort((left, right) => left.date.localeCompare(right.date));

  return ordered.map((outflow) => {
    const wanted = Math.abs(outflow.amountMinor);
    const candidates = available.filter(
      (entry) =>
        !entry.used &&
        entry.leg.amountMinor === wanted &&
        daysApart(entry.leg.date, outflow.date) <= CARD_PAYMENT_WINDOW_DAYS,
    );

    const cardAccountIds = [...new Set(candidates.map((entry) => entry.leg.cardAccountId))];
    if (cardAccountIds.length !== 1) {
      return cardAccountIds.length > 1
        ? { kind: "ambiguous" as const, transactionId: outflow.transactionId, cardAccountIds }
        : { kind: "unmatched" as const, transactionId: outflow.transactionId };
    }

    const chosen = candidates.sort(
      (left, right) =>
        daysApart(left.leg.date, outflow.date) - daysApart(right.leg.date, outflow.date),
    )[0]!;
    chosen.used = true;
    return {
      kind: "matched" as const,
      transactionId: outflow.transactionId,
      cardAccountId: chosen.leg.cardAccountId,
      legId: chosen.leg.id,
    };
  });
}
