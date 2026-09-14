/**
 * Recognising two provider rows as one movement between the user's own accounts.
 *
 * When both accounts are connected, the same money arrives twice: a credit on
 * the destination and a debit on the source. Left alone the credit counts as
 * income and the debit as spending, so a Pix from your own savings inflates both
 * headline numbers by the amount you moved. PRD R5 says a transfer between your
 * own accounts has two legs and nets to zero.
 *
 * This is the bank-to-bank sibling of `card-payments.ts`, and the two differ in
 * what is stored. A card bill is only ever seen from the bank side, so its
 * destination leg is derived. Here both sides really are stored, and the ledger
 * has no room for that: `transactions_amount_sign_check` requires a `transfer`
 * row to be negative and `transactions_transfer_account_check` requires it to
 * name a destination, so a pair becomes exactly one negative row on the source
 * pointing at the destination. Deciding which inflow belongs to which outflow is
 * therefore the whole job, and it is pure because a wrong pairing silently
 * retires someone's real income.
 */

/** One side of a candidate movement, as stored in the ledger. */
export interface SelfTransferLeg {
  transactionId: string;
  /** The Hermes account the row sits on. */
  accountId: string;
  date: string;
  /** Signed: negative leaves the account, positive arrives. */
  amountMinor: number;
  /**
   * The provider called this a movement between accounts of the same holder.
   *
   * A hint, never a requirement. Pluggy labels some of these `Same person
   * transfer` and others only `Transfer - PIX`, which is the same label it puts
   * on money from a third party, so requiring it would miss real pairs. It earns
   * its keep as a tie-breaker: see `matchSelfTransfers`.
   */
  sameOwnerHint?: boolean;
}

export type SelfTransferMatch =
  | {
      kind: "matched";
      outflowTransactionId: string;
      inflowTransactionId: string;
      /** The account the money arrived in — the surviving row's destination. */
      inflowAccountId: string;
      amountMinor: number;
    }
  | {
      kind: "ambiguous";
      outflowTransactionId: string;
      /** The distinct destination accounts that all answered the description. */
      inflowAccountIds: string[];
    }
  | { kind: "unmatched"; outflowTransactionId: string };

/**
 * How far apart the two legs may be.
 *
 * A Pix settles instantly, so same-day is the normal case; the slack is for a
 * weekend, a late posting, and two connectors that disagree about which calendar
 * day a late-night transfer fell on. Held to the same width as
 * `CARD_PAYMENT_WINDOW_DAYS` because it answers the same question.
 */
export const SELF_TRANSFER_WINDOW_DAYS = 2;

function daysApart(left: string, right: string): number {
  const a = Date.parse(`${left}T00:00:00.000Z`);
  const b = Date.parse(`${right}T00:00:00.000Z`);
  return Math.abs(a - b) / 86_400_000;
}

/**
 * Pair every outflow with the inflow that is the other side of it.
 *
 * The amount has to match exactly — this is one movement seen twice, not an
 * approximation — the dates have to be close, and the two legs have to sit on
 * different accounts, since a row cannot be a transfer to itself.
 *
 * Two different destination accounts answering the same outflow is not resolved.
 * PRD §14 forbids choosing arbitrarily between plausible matches, and here the
 * choice would move real money between two real accounts, so it is reported for
 * a human instead. Several candidates within one account are a different story:
 * whichever is chosen the resulting ledger is identical, so the closest date
 * wins and the rest stay available. That is the same distinction
 * `matchCardPayments` draws, for the same reason.
 *
 * The provider's same-holder hint narrows the field when it is present on some
 * candidates and not others, which is what stops a genuine payment from a third
 * party of coincidentally equal value from being preferred over the real leg.
 *
 * Each inflow is consumed once: moving the same amount twice in a week is
 * ordinary, and a second outflow must not claim a leg the first already used.
 */
export function matchSelfTransfers(
  legs: readonly SelfTransferLeg[],
): SelfTransferMatch[] {
  const available = legs
    .filter((leg) => leg.amountMinor > 0)
    .map((leg) => ({ leg, used: false }));

  const outflows = legs
    .filter((leg) => leg.amountMinor < 0)
    // Sorted so a batch decides the same way whatever order the rows were read
    // in; the id breaks ties between two outflows on the same day.
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        left.transactionId.localeCompare(right.transactionId),
    );

  return outflows.map((outflow) => {
    const wanted = Math.abs(outflow.amountMinor);
    let candidates = available.filter(
      (entry) =>
        !entry.used &&
        entry.leg.amountMinor === wanted &&
        entry.leg.accountId !== outflow.accountId &&
        daysApart(entry.leg.date, outflow.date) <= SELF_TRANSFER_WINDOW_DAYS,
    );

    const hinted = candidates.filter(
      (entry) => entry.leg.sameOwnerHint || outflow.sameOwnerHint,
    );
    if (hinted.length > 0) candidates = hinted;

    const inflowAccountIds = [...new Set(candidates.map((entry) => entry.leg.accountId))];
    if (inflowAccountIds.length > 1) {
      return {
        kind: "ambiguous" as const,
        outflowTransactionId: outflow.transactionId,
        inflowAccountIds,
      };
    }
    if (inflowAccountIds.length === 0) {
      return { kind: "unmatched" as const, outflowTransactionId: outflow.transactionId };
    }

    const chosen = candidates.sort(
      (left, right) =>
        daysApart(left.leg.date, outflow.date) - daysApart(right.leg.date, outflow.date) ||
        left.leg.transactionId.localeCompare(right.leg.transactionId),
    )[0]!;
    chosen.used = true;

    return {
      kind: "matched" as const,
      outflowTransactionId: outflow.transactionId,
      inflowTransactionId: chosen.leg.transactionId,
      inflowAccountId: chosen.leg.accountId,
      amountMinor: wanted,
    };
  });
}
