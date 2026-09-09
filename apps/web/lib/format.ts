import { formatMoney as formatMoneyRaw, fromIsoDate, type FormatMoneyOptions } from "@kosh/domain";

/**
 * Money formatting for the web app.
 *
 * `@kosh/domain` stays free of any environment lookup, so the deployment
 * default is applied here, at the boundary, rather than inside the pure
 * package. An explicit `locale` from the caller always wins.
 */
export function formatMoney(
  amountMinor: number,
  currencyCode: string,
  options: FormatMoneyOptions = {},
): string {
  return formatMoneyRaw(amountMinor, currencyCode, {
    ...options,
    locale: options.locale ?? DEFAULT_LOCALE,
  });
}

/** "₹1,23,456" with an explicit sign — the standard amount rendering. */
export function formatAmount(
  amountMinor: number,
  currencyCode: string,
  locale?: string,
): string {
  return formatMoney(amountMinor, currencyCode, {
    locale,
    signDisplay: amountMinor > 0 ? "always" : "auto",
  });
}

/** Unsigned amount for totals/targets. */
export function formatAbsAmount(
  amountMinor: number,
  currencyCode: string,
  locale?: string,
): string {
  return formatMoney(Math.abs(amountMinor), currencyCode, { locale });
}

/**
 * Locale used whenever a call site has no user locale in scope.
 *
 * Per-user locale lives in `user_settings.locale` and is passed explicitly by
 * call sites that have a user loaded. On a self-hosted single-user install the
 * deployment-wide default is what actually decides how most of the app reads,
 * so it is configurable rather than frozen to one country. It must be a
 * `NEXT_PUBLIC_` variable because client components format money and dates too.
 */
const DEFAULT_LOCALE = process.env.NEXT_PUBLIC_KOSH_LOCALE || "en-IN";

// Intl.DateTimeFormat construction is comparatively expensive, so instances
// are memoized per locale instead of being built on every call (as a
// module-level singleton would if we simply moved the locale into the
// function body) or once per invocation.
const dateFormatCache = new Map<string, Intl.DateTimeFormat>();
const dateFormatShortCache = new Map<string, Intl.DateTimeFormat>();
const dateFormatCompactCache = new Map<string, Intl.DateTimeFormat>();
const monthFormatCache = new Map<string, Intl.DateTimeFormat>();

function getDateFormat(locale: string): Intl.DateTimeFormat {
  let format = dateFormatCache.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    dateFormatCache.set(locale, format);
  }
  return format;
}

function getDateFormatShort(locale: string): Intl.DateTimeFormat {
  let format = dateFormatShortCache.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "short",
    });
    dateFormatShortCache.set(locale, format);
  }
  return format;
}

function getDateFormatCompact(locale: string): Intl.DateTimeFormat {
  let format = dateFormatCompactCache.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "short",
      year: "2-digit",
    });
    dateFormatCompactCache.set(locale, format);
  }
  return format;
}

function getMonthFormat(locale: string): Intl.DateTimeFormat {
  let format = monthFormatCache.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
    });
    monthFormatCache.set(locale, format);
  }
  return format;
}

/** "05 Jun 2026" from an ISO date string. */
export function formatDate(iso: string, locale: string = DEFAULT_LOCALE): string {
  return getDateFormat(locale).format(fromIsoDate(iso));
}

/** "05 Jun" for dense tables. */
export function formatDateShort(iso: string, locale: string = DEFAULT_LOCALE): string {
  return getDateFormatShort(locale).format(fromIsoDate(iso));
}

/**
 * "05 Jun 26" — for a dense table that still spans years. Without the year, a
 * row from a past year reads as this year's, which is worse than the two
 * characters it costs.
 */
export function formatDateCompact(iso: string, locale: string = DEFAULT_LOCALE): string {
  return getDateFormatCompact(locale).format(fromIsoDate(iso));
}

/** "Jun 2026" from "2026-06" or a full ISO date. */
export function formatMonth(isoMonth: string, locale: string = DEFAULT_LOCALE): string {
  return getMonthFormat(locale).format(fromIsoDate(`${isoMonth.slice(0, 7)}-01`));
}

export function formatRelativeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
