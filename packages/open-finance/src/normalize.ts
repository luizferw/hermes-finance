/**
 * Pure translation from Pluggy payloads to Hermes facts.
 *
 * Nothing here performs IO. Everything returns integer minor units and
 * `YYYY-MM-DD` calendar days, which is the only shape the rest of the system
 * accepts. The adapter in `apps/web` decides what to persist; this file decides
 * what the numbers *mean*.
 */
import type {
  PluggyAccount,
  PluggyBill,
  PluggyTransaction,
} from "./wire";

/**
 * Resolving the minor-unit exponent is the caller's job so this package stays
 * free of a dependency on `@kosh/domain` (see the package boundaries in
 * CLAUDE.md). The web adapter passes `minorUnitExponent` from there.
 */
export interface NormalizeContext {
  minorUnitExponent(currencyCode: string): number;
  /** Used when Pluggy omits the currency on a record. */
  defaultCurrencyCode: string;
  /** Defaults to Brazil's fixed UTC-3. */
  utcOffsetMinutes?: number;
}

/** Brazil runs at UTC-3 year round; the daylight-saving rule was repealed in 2019. */
export const BRAZIL_UTC_OFFSET_MINUTES = -180;

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Expand a JS number into plain decimal notation without losing digits.
 *
 * `String(value)` yields the shortest decimal that round-trips to the same
 * double, which for a value parsed out of JSON is exactly the literal Pluggy
 * wrote. Working from that text instead of from arithmetic is what keeps
 * `10000.76` from becoming `1000075` minor units.
 */
function toPlainDecimalString(value: number): string {
  const text = String(value);
  if (!/e/i.test(text)) return text;

  const [mantissa = "0", exponentText = "0"] = text.split(/e/i);
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [integerPart = "0", fractionPart = ""] = unsigned.split(".");
  const digits = integerPart + fractionPart;
  const pointIndex = integerPart.length + exponent;

  let plain: string;
  if (pointIndex <= 0) {
    plain = `0.${"0".repeat(-pointIndex)}${digits}`;
  } else if (pointIndex >= digits.length) {
    plain = digits + "0".repeat(pointIndex - digits.length);
  } else {
    plain = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  }
  return negative ? `-${plain}` : plain;
}

/**
 * Pluggy sends money as a float in major units (`142.41`). Hermes stores
 * integer minor units, so this is the single most dangerous conversion in the
 * integration: an off-by-one cent here is a wrong balance forever.
 *
 * Rounding is half-away-from-zero on the magnitude, so -0.005 and 0.005 both
 * round to one minor unit rather than the asymmetric behaviour of `Math.round`.
 * In practice Pluggy never sends more precision than the currency has.
 */
export function amountToMinor(amount: number, exponent: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`amount must be a finite number, received ${String(amount)}`);
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    throw new Error(`minor unit exponent out of range: ${String(exponent)}`);
  }

  const text = toPlainDecimalString(amount);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [integerPart = "0", fractionPart = ""] = unsigned.split(".");

  const kept = fractionPart.slice(0, exponent).padEnd(exponent, "0");
  const dropped = fractionPart.slice(exponent);
  let magnitude = Number(`${integerPart}${kept}`);
  if (dropped.charCodeAt(0) >= /* "5" */ 53) magnitude += 1;

  if (!Number.isSafeInteger(magnitude)) {
    throw new Error(`amount ${text} does not fit in a safe integer of minor units`);
  }
  return negative ? -magnitude : magnitude;
}

function optionalAmountToMinor(
  amount: number | null | undefined,
  exponent: number,
): number | null {
  return amount === null || amount === undefined ? null : amountToMinor(amount, exponent);
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reduce a Pluggy ISO8601 timestamp to the Brazilian calendar day.
 *
 * Pluggy documents these as UTC and tells integrators to shift to GMT-3, but it
 * sends a plain date as midnight UTC. Shifting that would move every posted
 * transaction one day earlier, so an exact midnight is read as a date rather
 * than an instant. A timestamp with a real time of day is a genuine instant and
 * does get shifted.
 */
export function brazilianCalendarDay(
  isoTimestamp: string,
  utcOffsetMinutes: number = BRAZIL_UTC_OFFSET_MINUTES,
): string {
  const instant = new Date(isoTimestamp);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`invalid ISO timestamp: ${isoTimestamp}`);
  }
  const isMidnightUtc =
    instant.getUTCHours() === 0 &&
    instant.getUTCMinutes() === 0 &&
    instant.getUTCSeconds() === 0 &&
    instant.getUTCMilliseconds() === 0;

  const shifted = isMidnightUtc
    ? instant
    : new Date(instant.getTime() + utcOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function dayOfMonth(
  isoTimestamp: string | null | undefined,
  utcOffsetMinutes?: number,
): number | null {
  if (!isoTimestamp) return null;
  const day = Number(brazilianCalendarDay(isoTimestamp, utcOffsetMinutes).slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

export type NormalizedAccountKind = "bank" | "credit";

export interface NormalizedAccount {
  externalId: string;
  /**
   * `bank` or `credit`, which is all the sign convention needs to know.
   * Deliberately coarse: everything that is not CREDIT behaves like a bank
   * account as far as amounts go.
   */
  kind: NormalizedAccountKind;
  /**
   * The provider's own type, uppercased and unflattened — INVESTMENT and LOAN
   * are not banks, and collapsing them into `kind` is how one would end up
   * modelled as a checking account.
   */
  providerType: string;
  subtype: string | null;
  name: string;
  /** Account number, or the last four digits for a card. */
  numberMask: string | null;
  currencyCode: string;
  /**
   * Signed integer minor units. Pluggy reports a card's open bill as a positive
   * debt; Hermes models a card as a liability, so it is negated here.
   */
  balanceMinor: number;
  creditLimitMinor: number | null;
  availableCreditMinor: number | null;
  minimumPaymentMinor: number | null;
  closingDay: number | null;
  dueDay: number | null;
  brand: string | null;
}

export function accountKindOf(account: PluggyAccount): NormalizedAccountKind {
  return account.type.toUpperCase() === "CREDIT" ? "credit" : "bank";
}

export function normalizeAccount(
  account: PluggyAccount,
  context: NormalizeContext,
): NormalizedAccount {
  const currencyCode = (account.currencyCode ?? context.defaultCurrencyCode).toUpperCase();
  const exponent = context.minorUnitExponent(currencyCode);
  const kind = accountKindOf(account);
  const credit = account.creditData ?? null;

  const reportedBalanceMinor = amountToMinor(account.balance, exponent);

  return {
    externalId: account.id,
    kind,
    providerType: account.type.toUpperCase(),
    subtype: account.subtype ?? null,
    name: (account.name ?? account.marketingName ?? "Account").trim(),
    numberMask: account.number?.trim() || null,
    currencyCode,
    balanceMinor: kind === "credit" ? -reportedBalanceMinor : reportedBalanceMinor,
    creditLimitMinor: optionalAmountToMinor(credit?.creditLimit, exponent),
    availableCreditMinor: optionalAmountToMinor(credit?.availableCreditLimit, exponent),
    minimumPaymentMinor: optionalAmountToMinor(credit?.minimumPayment, exponent),
    closingDay: dayOfMonth(credit?.balanceCloseDate, context.utcOffsetMinutes),
    dueDay: dayOfMonth(credit?.balanceDueDate, context.utcOffsetMinutes),
    brand: credit?.brand ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

export interface NormalizedInstallment {
  number: number;
  total: number;
  totalAmountMinor: number | null;
}

export interface NormalizedTransaction {
  kind: "transaction";
  externalId: string;
  /** Only income and expense: a transfer needs a counterparty we cannot infer. */
  type: "income" | "expense";
  /**
   * Only `imported | reviewed | posted` count toward an account balance, so
   * this field decides whether a row moves the ledger. See `statusFor`.
   */
  status: "imported" | "pending";
  date: string;
  /** Signed to satisfy the ledger CHECK: income > 0, expense < 0. */
  amountMinor: number;
  currencyCode: string;
  description: string;
  rawDescription: string | null;
  merchant: string | null;
  providerCategory: string | null;
  /** The bill (fatura) this charge will settle in, when Pluggy links one. */
  billExternalId: string | null;
  installment: NormalizedInstallment | null;
  /**
   * A bank outflow that looks like a credit-card bill payment. Recorded as a
   * hint only: pairing the two legs into a transfer is reconciliation proper
   * (PRD §14, §29) and is not attempted during a sync.
   */
  cardPaymentCandidate: boolean;
}

export interface SkippedTransaction {
  kind: "skipped";
  externalId: string;
  reason: "card_payment_leg" | "zero_amount";
}

export type NormalizedTransactionResult = NormalizedTransaction | SkippedTransaction;

const CARD_PAYMENT_HINTS = [
  "pagamento de fatura",
  "pagamento fatura",
  "pagto fatura",
  "pgto fatura",
  "pagamento cartao",
  "pagamento de cartao",
  "pagto cartao",
  "pgto cartao",
  "fatura cartao",
  "credit card payment",
];

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function looksLikeCardBillPayment(description: string): boolean {
  const normalized = stripDiacritics(description.toLowerCase()).replace(/\s+/g, " ").trim();
  return CARD_PAYMENT_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Where a provider row lands in the ledger's status enum.
 *
 * The mapping is asymmetric on purpose. On a bank account PENDING is an
 * authorization that may never settle, or may settle at another amount, so it
 * stays out of the balance — the real bank balance already reflects the hold,
 * and counting the row too would double count it (PRD R3).
 *
 * On a card, PENDING means the charge sits on the open invoice or is a future
 * installment. That purchase already happened: PRD R4 makes it an economic
 * expense dated at the purchase, not a projection. Booking it as `pending`
 * would also split the card in half, because `deriveLedgerCycles` in
 * `modules/finance/queries.ts` counts card rows regardless of status while the
 * debt it is capped against comes from the status-filtered account balance.
 */
export function statusFor(
  providerStatus: string | null | undefined,
  accountKind: NormalizedAccountKind,
): "imported" | "pending" {
  if (providerStatus?.toUpperCase() !== "PENDING") return "imported";
  return accountKind === "credit" ? "imported" : "pending";
}

function installmentOf(
  transaction: PluggyTransaction,
  exponent: number,
): NormalizedInstallment | null {
  const metadata = transaction.creditCardMetadata;
  const total = metadata?.totalInstallments ?? null;
  const number = metadata?.installmentNumber ?? null;
  if (!total || !number || total <= 1 || number < 1 || number > total) return null;
  return {
    number,
    total,
    totalAmountMinor: optionalAmountToMinor(metadata?.totalAmount, exponent),
  };
}

/**
 * Resolve a Pluggy transaction into a ledger fact.
 *
 * The sign convention differs by account kind and getting it backwards would
 * invert every card expense: on a BANK account a positive amount is money in,
 * while on a CREDIT account a positive amount is a purchase that *adds* to the
 * bill and a negative amount is the cardholder paying it off.
 */
export function normalizeTransaction(
  transaction: PluggyTransaction,
  accountKind: NormalizedAccountKind,
  context: NormalizeContext,
): NormalizedTransactionResult {
  const currencyCode = (transaction.currencyCode ?? context.defaultCurrencyCode).toUpperCase();
  const exponent = context.minorUnitExponent(currencyCode);
  const signedMinor = amountToMinor(transaction.amount, exponent);

  if (signedMinor === 0) {
    return { kind: "skipped", externalId: transaction.id, reason: "zero_amount" };
  }

  // On a card, a negative amount is the statement settlement. It is a cash-flow
  // event on the paying account, not an expense of its own (PRD R4), and the
  // bank side of the pair is ingested instead.
  if (accountKind === "credit" && signedMinor < 0) {
    return { kind: "skipped", externalId: transaction.id, reason: "card_payment_leg" };
  }

  const ledgerMinor = accountKind === "credit" ? -signedMinor : signedMinor;
  const description =
    transaction.description?.trim() || transaction.descriptionRaw?.trim() || "Untitled transaction";

  return {
    kind: "transaction",
    externalId: transaction.id,
    type: ledgerMinor > 0 ? "income" : "expense",
    status: statusFor(transaction.status, accountKind),
    date: brazilianCalendarDay(transaction.date, context.utcOffsetMinutes),
    amountMinor: ledgerMinor,
    currencyCode,
    description,
    rawDescription: transaction.descriptionRaw?.trim() || null,
    merchant: transaction.merchantName?.trim() || null,
    providerCategory: transaction.category ?? null,
    billExternalId: transaction.creditCardMetadata?.billId ?? null,
    installment: installmentOf(transaction, exponent),
    cardPaymentCandidate:
      accountKind === "bank" && ledgerMinor < 0 && looksLikeCardBillPayment(description),
  };
}

/* -------------------------------------------------------------------------- */
/* Bills                                                                      */
/* -------------------------------------------------------------------------- */

export interface NormalizedBill {
  externalId: string;
  /**
   * Deliberately absent: the statement month.
   *
   * A cycle is keyed by `nominalCycleFor(closingDate, closingDay, dueDay)` in
   * `@hermes-finance/forecast`, which is what `registerCardPurchase` and
   * `deriveLedgerCycles` already use. Deriving it here from the due date would
   * produce a second, parallel cycle for the same month and count the bill
   * twice (PRD R3). The adapter computes it with that shared function.
   */
  closedAt: string | null;
  dueAt: string;
  totalMinor: number;
  minimumPaymentMinor: number | null;
  paidAt: string | null;
  isPaid: boolean;
}

export function normalizeBill(bill: PluggyBill, context: NormalizeContext): NormalizedBill {
  const currencyCode = (bill.totalAmountCurrencyCode ?? context.defaultCurrencyCode).toUpperCase();
  const exponent = context.minorUnitExponent(currencyCode);
  const dueAt = brazilianCalendarDay(bill.dueDate, context.utcOffsetMinutes);
  const payments = bill.payments;
  const lastPaymentDate = payments
    .map((payment) => payment.paymentDate)
    .filter((date): date is string => Boolean(date))
    .map((date) => brazilianCalendarDay(date, context.utcOffsetMinutes))
    .sort()
    .at(-1);

  return {
    externalId: bill.id,
    closedAt: bill.billClosingDate
      ? brazilianCalendarDay(bill.billClosingDate, context.utcOffsetMinutes)
      : null,
    dueAt,
    totalMinor: amountToMinor(bill.totalAmount, exponent),
    minimumPaymentMinor: optionalAmountToMinor(bill.minimumPaymentAmount, exponent),
    paidAt: lastPaymentDate ?? null,
    isPaid: payments.length > 0,
  };
}
