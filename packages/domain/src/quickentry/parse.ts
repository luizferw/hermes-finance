/**
 * Quick-entry parser: turns a one-line command like "coffee 180 upi" into a
 * transaction draft. Deterministic, no AI. The UI resolves method/merchant
 * hints into real account/category IDs (merchant memory) before saving.
 */
import { parseAmountToMinor } from "../shared/money";

export interface QuickEntryDraft {
  /** Human label, e.g. "coffee". Empty string if nothing descriptive given. */
  description: string;
  merchant: string | null;
  /** Always positive minor units; sign comes from `type`. */
  amountMinor: number;
  type: "income" | "expense";
  /** Normalized payment method, e.g. "upi", "cash", "card". null if absent. */
  method: string | null;
  /** From a #token. UI maps to a category. */
  categoryHint: string | null;
  /** From an @token. UI maps to an account. */
  accountHint: string | null;
  /** yyyy-MM-dd in local time. */
  date: string;
}

// Method word -> canonical method. gpay/phonepe/paytm all settle over UPI but
// keep the app the user named; collapse only the obvious synonyms.
const METHODS: Record<string, string> = {
  upi: "upi",
  gpay: "gpay",
  googlepay: "gpay",
  phonepe: "phonepe",
  paytm: "paytm",
  cash: "cash",
  card: "card",
  credit: "card",
  debit: "card",
  neft: "neft",
  imps: "imps",
  rtgs: "rtgs",
  netbanking: "netbanking",
};

const INCOME_WORDS = new Set([
  "salary",
  "refund",
  "refunded",
  "received",
  "credited",
  "income",
  "cashback",
]);

function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface ParseQuickEntryOptions {
  currencyCode?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export function parseQuickEntry(
  input: string,
  options: ParseQuickEntryOptions = {},
): QuickEntryDraft | null {
  const { currencyCode = "INR", now = new Date() } = options;
  if (typeof input !== "string") return null;

  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let amountMinor: number | null = null;
  let method: string | null = null;
  let categoryHint: string | null = null;
  let accountHint: string | null = null;
  let type: "income" | "expense" = "expense";
  let dateOffsetDays = 0;
  const descWords: string[] = [];

  for (const tok of tokens) {
    const lower = tok.toLowerCase();

    if (tok.startsWith("#") && tok.length > 1) {
      categoryHint = tok.slice(1);
      continue;
    }
    if (tok.startsWith("@") && tok.length > 1) {
      accountHint = tok.slice(1);
      continue;
    }
    if (method === null && METHODS[lower]) {
      method = METHODS[lower];
      continue;
    }
    if (lower === "today") continue;
    if (lower === "yesterday") {
      dateOffsetDays = -1;
      continue;
    }
    // first amount-looking token wins. "table 2 chairs 500" mis-picks
    // 2 — acceptable; ambiguous input is meant to land in a UI confirm card,
    // not be silently guessed. Upgrade: prefer the largest/last number.
    if (amountMinor === null) {
      const parsed = parseAmountToMinor(tok, currencyCode);
      if (parsed !== null) {
        amountMinor = Math.abs(parsed);
        if (parsed < 0) type = "income"; // explicit "-" / "(...)" reads as inflow
        continue;
      }
    }
    if (INCOME_WORDS.has(lower)) type = "income";
    descWords.push(tok);
  }

  if (amountMinor === null) return null;

  const date = new Date(now);
  date.setDate(date.getDate() + dateOffsetDays);

  const description = descWords.join(" ");
  return {
    description,
    merchant: description || null,
    amountMinor,
    type,
    method,
    categoryHint,
    accountHint,
    date: toLocalISODate(date),
  };
}
