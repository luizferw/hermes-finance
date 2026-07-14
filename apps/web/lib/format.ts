import { formatMoney, fromIsoDate } from "@kosh/domain";

export { formatMoney };

/** "₹1,23,456" with an explicit sign — the standard amount rendering. */
export function formatAmount(amountMinor: number, currencyCode: string): string {
  return formatMoney(amountMinor, currencyCode, {
    signDisplay: amountMinor > 0 ? "always" : "auto",
  });
}

/** Unsigned amount for totals/targets. */
export function formatAbsAmount(amountMinor: number, currencyCode: string): string {
  return formatMoney(Math.abs(amountMinor), currencyCode);
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const DATE_FORMAT_SHORT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
});

/** "05 Jun 2026" from an ISO date string. */
export function formatDate(iso: string): string {
  return DATE_FORMAT.format(fromIsoDate(iso));
}

/** "05 Jun" for dense tables. */
export function formatDateShort(iso: string): string {
  return DATE_FORMAT_SHORT.format(fromIsoDate(iso));
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-IN", {
  month: "short",
  year: "numeric",
});

/** "Jun 2026" from "2026-06" or a full ISO date. */
export function formatMonth(isoMonth: string): string {
  return MONTH_FORMAT.format(fromIsoDate(`${isoMonth.slice(0, 7)}-01`));
}

export function formatRelativeDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
