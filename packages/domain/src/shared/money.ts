/**
 * Money is always integer minor units (paise, cents) plus an ISO 4217
 * currency code. Floating point never touches stored amounts.
 */

const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
};

export function minorUnitExponent(currencyCode: string): number {
  return MINOR_UNIT_EXPONENTS[currencyCode.toUpperCase()] ?? 2;
}

/** 123456 (INR) -> 1234.56 */
export function minorToMajor(amountMinor: number, currencyCode: string): number {
  return amountMinor / 10 ** minorUnitExponent(currencyCode);
}

/** "1234.56" / 1234.56 (INR) -> 123456. Rounds to the nearest minor unit. */
export function majorToMinor(amountMajor: number, currencyCode: string): number {
  return Math.round(amountMajor * 10 ** minorUnitExponent(currencyCode));
}

export interface FormatMoneyOptions {
  locale?: string;
  /** Always show an explicit +/- sign. */
  signDisplay?: "auto" | "always" | "never" | "exceptZero";
  /** Drop decimals when the amount is whole (₹1,200 instead of ₹1,200.00). */
  compactDecimals?: boolean;
}

// "en-IN" used to be the default here, but that baked a single country's
// formatting (lakh grouping) into a shared, currency-agnostic utility. The
// product now supports multiple user locales (see user_settings.locale), so
// callers that have a user in scope must always pass `options.locale`
// explicitly. "en-US" is kept only as a neutral, universally-supported ICU
// fallback for callers with no user context (e.g. scripts, tests).
export function formatMoney(
  amountMinor: number,
  currencyCode: string,
  options: FormatMoneyOptions = {},
): string {
  const { locale = "en-US", signDisplay = "auto", compactDecimals = true } = options;
  const exponent = minorUnitExponent(currencyCode);
  const major = minorToMajor(amountMinor, currencyCode);
  const isWhole = amountMinor % 10 ** exponent === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
    signDisplay,
    minimumFractionDigits: compactDecimals && isWhole ? 0 : exponent,
    maximumFractionDigits: exponent,
  }).format(major);
}

/**
 * Parse a human/CSV amount string into minor units.
 *
 * Handles: "1,234.56", "₹ 1,234.56", "1.234,56" (EU), "(500)" accounting
 * negatives, "1234.56 CR"/"DR" suffixes, "-1,234.56", Indian lakh grouping.
 * Returns null when the string is not a recognizable number.
 */
export function parseAmountToMinor(
  input: string,
  currencyCode: string,
): number | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s === "") return null;

  let negative = false;

  // Accounting parentheses: (1,234.56)
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // CR/DR suffixes used in Indian statements (CR = credit/inflow).
  const crdr = s.match(/\b(CR|DR)\.?$/i);
  if (crdr) {
    if (crdr[1]!.toUpperCase() === "DR") negative = true;
    s = s.slice(0, crdr.index).trim();
  }
  // Strip currency symbols, codes, spaces.
  s = s.replace(/[₹$€£¥]|\b[A-Z]{3}\b/gi, "").trim();

  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  s = s.trim();
  if (s === "") return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let normalized = s;
  if (hasComma && hasDot) {
    // The rightmost separator is the decimal point.
    normalized =
      s.lastIndexOf(".") > s.lastIndexOf(",")
        ? s.replace(/,/g, "")
        : s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    // Grouping if it looks like western ("1,234,567") or Indian
    // ("1,23,456") digit groups — both end in a 3-digit group. Anything
    // else ("12,50") is a decimal comma.
    const westernGrouping = /^\d{1,3}(,\d{3})+$/;
    const indianGrouping = /^\d{1,2}(,\d{2})*,\d{3}$/;
    normalized =
      westernGrouping.test(s) || indianGrouping.test(s)
        ? s.replace(/,/g, "")
        : s.replace(",", ".");
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

  const major = Number.parseFloat(normalized);
  if (!Number.isFinite(major)) return null;
  const minor = majorToMinor(major, currencyCode);
  return negative ? -minor : minor;
}
