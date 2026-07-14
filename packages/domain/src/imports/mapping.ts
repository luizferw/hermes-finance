import { parseAmountToMinor } from "../shared/money";
import { parseDateString } from "../shared/dates";

/**
 * Fields a CSV column can be mapped to. `debit`/`credit` are alternatives to
 * a single signed `amount` column — Indian bank statements almost always use
 * separate withdrawal/deposit columns.
 */
export const IMPORT_FIELDS = [
  "date",
  "valueDate",
  "description",
  "amount",
  "debit",
  "credit",
  "externalId",
  "upiReference",
  "utrNumber",
  "narration",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Kosh field -> source CSV column name. */
export type ColumnMapping = Partial<Record<ImportField, string>>;

export interface ParsedImportRow {
  date: string | null;
  valueDate: string | null;
  amountMinor: number | null;
  description: string;
  externalId: string | null;
  upiReference: string | null;
  utrNumber: string | null;
  narration: string | null;
  error: string | null;
}

/**
 * Suggest a mapping from CSV headers using common bank-statement column
 * names (HDFC, ICICI, SBI, Axis exports and generic English headers).
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const normalized = headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));

  const firstMatch = (candidates: string[]): string | undefined => {
    for (const candidate of candidates) {
      const idx = normalized.findIndex((h) => h.includes(candidate));
      if (idx !== -1) return headers[idx];
    }
    return undefined;
  };

  const assign = (field: ImportField, candidates: string[]) => {
    const used = new Set(Object.values(mapping));
    for (const candidate of candidates) {
      const idx = normalized.findIndex(
        (h, i) => h.includes(candidate) && !used.has(headers[i]!),
      );
      if (idx !== -1) {
        mapping[field] = headers[idx]!;
        return;
      }
    }
  };

  assign("date", ["txndate", "transactiondate", "tradate", "date"]);
  assign("valueDate", ["valuedate", "valuedt"]);
  assign("debit", ["withdrawalamt", "withdrawal", "debit"]);
  assign("credit", ["depositamt", "deposit", "credit"]);
  if (!mapping.debit && !mapping.credit) {
    assign("amount", ["amount", "amt"]);
  }
  assign("description", ["narration", "description", "particulars", "remarks", "details"]);
  assign("externalId", ["chqrefno", "refno", "referenceno", "reference", "transactionid", "txnid"]);
  assign("utrNumber", ["utr"]);
  assign("upiReference", ["upiref", "upi"]);

  // If description got the narration column, also expose it as narration.
  const narrationHeader = firstMatch(["narration"]);
  if (narrationHeader) mapping.narration = narrationHeader;

  return mapping;
}

export interface ApplyMappingOptions {
  currencyCode: string;
  dateFormat?: string;
}

/** Apply a column mapping to one raw CSV row. Never throws — errors land in `error`. */
export function applyMapping(
  raw: Record<string, string>,
  mapping: ColumnMapping,
  options: ApplyMappingOptions,
): ParsedImportRow {
  const get = (field: ImportField): string =>
    mapping[field] ? (raw[mapping[field]!] ?? "").trim() : "";

  const result: ParsedImportRow = {
    date: null,
    valueDate: null,
    amountMinor: null,
    description: "",
    externalId: null,
    upiReference: null,
    utrNumber: null,
    narration: null,
    error: null,
  };

  const errors: string[] = [];

  const dateRaw = get("date");
  if (!mapping.date) {
    errors.push("No date column mapped");
  } else if (dateRaw === "") {
    errors.push("Empty date");
  } else {
    result.date = parseDateString(dateRaw, options.dateFormat);
    if (!result.date) errors.push(`Unrecognized date "${dateRaw}"`);
  }

  const valueDateRaw = get("valueDate");
  if (valueDateRaw) {
    result.valueDate = parseDateString(valueDateRaw, options.dateFormat);
  }

  // Amount: single signed column, or separate debit/credit columns.
  if (mapping.amount) {
    const amountRaw = get("amount");
    if (amountRaw === "") {
      errors.push("Empty amount");
    } else {
      result.amountMinor = parseAmountToMinor(amountRaw, options.currencyCode);
      if (result.amountMinor === null) {
        errors.push(`Unrecognized amount "${amountRaw}"`);
      }
    }
  } else if (mapping.debit || mapping.credit) {
    const debitRaw = get("debit");
    const creditRaw = get("credit");
    const debit = debitRaw ? parseAmountToMinor(debitRaw, options.currencyCode) : null;
    const credit = creditRaw ? parseAmountToMinor(creditRaw, options.currencyCode) : null;
    if (debit !== null && debit !== 0) {
      result.amountMinor = -Math.abs(debit);
    } else if (credit !== null && credit !== 0) {
      result.amountMinor = Math.abs(credit);
    } else {
      errors.push("Neither debit nor credit has a value");
    }
  } else {
    errors.push("No amount column mapped");
  }

  result.description = get("description") || get("narration");
  if (result.description === "") errors.push("Empty description");

  result.externalId = get("externalId") || null;
  result.upiReference = get("upiReference") || null;
  result.utrNumber = get("utrNumber") || null;
  result.narration = get("narration") || null;

  if (errors.length > 0) result.error = errors.join("; ");
  return result;
}
