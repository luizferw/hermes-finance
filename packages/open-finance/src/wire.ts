/**
 * Runtime shapes of the Pluggy REST payloads we consume.
 *
 * These describe someone else's API, so every field we read is checked rather
 * than trusted: a string where a number belongs would otherwise become a wrong
 * amount in the ledger, silently. Fields we do not read are ignored instead of
 * rejected — Pluggy ships new attributes without warning, and a strict schema
 * would turn an additive change on their side into a failed sync on ours.
 *
 * The checking is hand-written so the package keeps the zero-runtime-dependency
 * shape of its sibling pure packages (`forecast`, `planning`).
 */

export class PluggyPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluggyPayloadError";
  }
}

type Json = Record<string, unknown>;

function asObject(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluggyPayloadError(`${path}: expected an object, received ${describe(value)}`);
  }
  return value as Json;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function requiredString(source: Json, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    throw new PluggyPayloadError(`${path}.${key}: expected a non-empty string, received ${describe(value)}`);
  }
  return value;
}

function optionalString(source: Json, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function requiredNumber(source: Json, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PluggyPayloadError(`${path}.${key}: expected a finite number, received ${describe(value)}`);
  }
  return value;
}

function optionalNumber(source: Json, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalInteger(source: Json, key: string): number | null {
  const value = optionalNumber(source, key);
  return value !== null && Number.isInteger(value) ? value : null;
}

function optionalObject(source: Json, key: string): Json | null {
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Json;
}

function optionalArray(source: Json, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

/* -------------------------------------------------------------------------- */

export interface PluggyConnector {
  id: number | null;
  name: string | null;
  imageUrl: string | null;
  primaryColor: string | null;
}

export interface PluggyItem {
  id: string;
  connector: PluggyConnector | null;
  /** Connection lifecycle: UPDATED, UPDATING, LOGIN_ERROR, WAITING_USER_INPUT, … */
  status: string | null;
  /** Outcome of the last execution: SUCCESS, PARTIAL_SUCCESS, INVALID_CREDENTIALS, … */
  executionStatus: string | null;
  /** When Pluggy last reached the institution. This is the freshness of the data (PRD R8). */
  lastUpdatedAt: string | null;
  consentExpiresAt: string | null;
  errorCode: string | null;
}

export interface PluggyCreditData {
  brand: string | null;
  balanceCloseDate: string | null;
  balanceDueDate: string | null;
  creditLimit: number | null;
  availableCreditLimit: number | null;
  minimumPayment: number | null;
}

export interface PluggyAccount {
  id: string;
  itemId: string | null;
  /** BANK or CREDIT. */
  type: string;
  /** CHECKING_ACCOUNT, SAVINGS_ACCOUNT or CREDIT_CARD. */
  subtype: string | null;
  /** Account number for BANK, the last four digits of the card for CREDIT. */
  number: string | null;
  name: string | null;
  marketingName: string | null;
  balance: number;
  currencyCode: string | null;
  creditData: PluggyCreditData | null;
}

export interface PluggyCreditCardMetadata {
  installmentNumber: number | null;
  totalInstallments: number | null;
  totalAmount: number | null;
  cardNumber: string | null;
  /** Links the charge to the bill (fatura) that will settle it. */
  billId: string | null;
}

export interface PluggyTransaction {
  id: string;
  accountId: string | null;
  description: string | null;
  descriptionRaw: string | null;
  currencyCode: string | null;
  amount: number;
  /** ISO8601 in UTC. */
  date: string;
  category: string | null;
  /** DEBIT or CREDIT, as Pluggy classifies the movement. */
  type: string | null;
  /** POSTED, or PENDING for open-invoice charges and future installments. */
  status: string | null;
  merchantName: string | null;
  /** Present on transfers and bill payments; used only as a hint. */
  paymentReason: string | null;
  creditCardMetadata: PluggyCreditCardMetadata | null;
}

export interface PluggyBillPayment {
  paymentDate: string | null;
  amount: number | null;
}

export interface PluggyBill {
  id: string;
  dueDate: string;
  billClosingDate: string | null;
  totalAmount: number;
  totalAmountCurrencyCode: string | null;
  minimumPaymentAmount: number | null;
  payments: PluggyBillPayment[];
}

/* -------------------------------------------------------------------------- */

export function parseAuthResponse(payload: unknown): { apiKey: string } {
  const root = asObject(payload, "auth");
  return { apiKey: requiredString(root, "apiKey", "auth") };
}

export function parseItem(payload: unknown): PluggyItem {
  const root = asObject(payload, "item");
  const connector = optionalObject(root, "connector");
  const error = optionalObject(root, "error");

  return {
    id: requiredString(root, "id", "item"),
    connector: connector
      ? {
          id: optionalInteger(connector, "id"),
          name: optionalString(connector, "name"),
          imageUrl: optionalString(connector, "imageUrl"),
          primaryColor: optionalString(connector, "primaryColor"),
        }
      : null,
    status: optionalString(root, "status"),
    executionStatus: optionalString(root, "executionStatus"),
    lastUpdatedAt: optionalString(root, "lastUpdatedAt") ?? optionalString(root, "updatedAt"),
    consentExpiresAt: optionalString(root, "consentExpiresAt"),
    errorCode: error ? optionalString(error, "code") : null,
  };
}

export function parseAccount(payload: unknown, index: number): PluggyAccount {
  const path = `accounts[${index}]`;
  const root = asObject(payload, path);
  const creditData = optionalObject(root, "creditData");

  return {
    id: requiredString(root, "id", path),
    itemId: optionalString(root, "itemId"),
    type: requiredString(root, "type", path),
    subtype: optionalString(root, "subtype"),
    number: optionalString(root, "number"),
    name: optionalString(root, "name"),
    marketingName: optionalString(root, "marketingName"),
    balance: requiredNumber(root, "balance", path),
    currencyCode: optionalString(root, "currencyCode"),
    creditData: creditData
      ? {
          brand: optionalString(creditData, "brand"),
          balanceCloseDate: optionalString(creditData, "balanceCloseDate"),
          balanceDueDate: optionalString(creditData, "balanceDueDate"),
          creditLimit: optionalNumber(creditData, "creditLimit"),
          availableCreditLimit: optionalNumber(creditData, "availableCreditLimit"),
          minimumPayment: optionalNumber(creditData, "minimumPayment"),
        }
      : null,
  };
}

export function parseTransaction(payload: unknown, index: number): PluggyTransaction {
  const path = `transactions[${index}]`;
  const root = asObject(payload, path);
  const merchant = optionalObject(root, "merchant");
  const paymentData = optionalObject(root, "paymentData");
  const metadata = optionalObject(root, "creditCardMetadata");

  return {
    id: requiredString(root, "id", path),
    accountId: optionalString(root, "accountId"),
    description: optionalString(root, "description"),
    descriptionRaw: optionalString(root, "descriptionRaw"),
    currencyCode: optionalString(root, "currencyCode"),
    amount: requiredNumber(root, "amount", path),
    date: requiredString(root, "date", path),
    category: optionalString(root, "category"),
    type: optionalString(root, "type"),
    status: optionalString(root, "status"),
    merchantName: merchant
      ? optionalString(merchant, "name") ?? optionalString(merchant, "businessName")
      : null,
    paymentReason: paymentData ? optionalString(paymentData, "reason") : null,
    creditCardMetadata: metadata
      ? {
          installmentNumber: optionalInteger(metadata, "installmentNumber"),
          totalInstallments: optionalInteger(metadata, "totalInstallments"),
          totalAmount: optionalNumber(metadata, "totalAmount"),
          cardNumber: optionalString(metadata, "cardNumber"),
          billId: optionalString(metadata, "billId"),
        }
      : null,
  };
}

export function parseBill(payload: unknown, index: number): PluggyBill {
  const path = `bills[${index}]`;
  const root = asObject(payload, path);

  return {
    id: requiredString(root, "id", path),
    dueDate: requiredString(root, "dueDate", path),
    billClosingDate: optionalString(root, "billClosingDate"),
    totalAmount: requiredNumber(root, "totalAmount", path),
    totalAmountCurrencyCode: optionalString(root, "totalAmountCurrencyCode"),
    minimumPaymentAmount: optionalNumber(root, "minimumPaymentAmount"),
    payments: optionalArray(root, "payments").map((payment) => {
      const entry = asObject(payment, `${path}.payments[]`);
      return {
        paymentDate: optionalString(entry, "paymentDate"),
        amount: optionalNumber(entry, "amount"),
      };
    }),
  };
}

/** `{ results: [...] }` — the page shape of /accounts and /bills. */
export function parseResults<T>(
  payload: unknown,
  path: string,
  parseItemAt: (value: unknown, index: number) => T,
): T[] {
  const root = asObject(payload, path);
  const results = root["results"];
  if (!Array.isArray(results)) {
    throw new PluggyPayloadError(`${path}.results: expected an array, received ${describe(results)}`);
  }
  return results.map(parseItemAt);
}

/** `{ results: [...], next }` — the cursor page shape of /v2/transactions. */
export function parseCursorPage<T>(
  payload: unknown,
  path: string,
  parseItemAt: (value: unknown, index: number) => T,
): { results: T[]; next: string | null } {
  const root = asObject(payload, path);
  return {
    results: parseResults(payload, path, parseItemAt),
    next: optionalString(root, "next"),
  };
}
