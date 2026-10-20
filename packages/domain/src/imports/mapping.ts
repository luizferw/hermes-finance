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
 * Header text reduced to bare ASCII letters, so "Descrição", "DESCRICAO" and
 * "Descricao " compare equal. Accents are folded before non-letters are
 * dropped; dropping first turned "Descrição" into "descrio" and nothing
 * Portuguese ever matched.
 */
function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * Suggest a mapping from CSV headers using common bank-statement column
 * names: HDFC, ICICI, SBI, Axis and generic English exports, and Brazilian
 * ones (Nubank, Inter, Itaú, Santander, Banco do Brasil: Data, Descrição,
 * Histórico, Lançamento, Valor, Débito/Crédito, Documento).
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const normalized = headers.map(normalizeHeader);

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

  // Specific transaction-date names first, then the value date, and only then
  // the bare "date"/"data": a bare "data" is a substring of "Data Valor", so
  // the value date has to be claimed before the generic pass runs.
  assign("date", [
    "txndate",
    "transactiondate",
    "tradate",
    "datalancamento",
    "datamovimento",
    "datatransacao",
    "datadacompra",
    "datacompra",
    "dataoperacao",
  ]);
  assign("valueDate", ["valuedate", "valuedt", "datavalor"]);
  if (!mapping.date) assign("date", ["date", "data"]);
  // A file whose only date column is the value date still needs a date.
  if (!mapping.date && mapping.valueDate) {
    mapping.date = mapping.valueDate;
    delete mapping.valueDate;
  }
  assign("debit", ["withdrawalamt", "withdrawal", "debit", "saida"]);
  assign("credit", ["depositamt", "deposit", "credit", "entrada"]);
  if (!mapping.debit && !mapping.credit) {
    assign("amount", ["amount", "amt", "valor"]);
  }
  assign("description", [
    "narration",
    "description",
    "particulars",
    "remarks",
    "details",
    "descricao",
    "historico",
    "lancamento",
    "detalhes",
    "estabelecimento",
    "title",
  ]);
  assign("externalId", [
    "chqrefno",
    "refno",
    "referenceno",
    "reference",
    "transactionid",
    "txnid",
    "identificador",
    "documento",
    "docto",
  ]);
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
