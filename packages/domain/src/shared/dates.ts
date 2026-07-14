/**
 * Civil-date helpers. All dates in the domain are ISO `yyyy-MM-dd` strings —
 * no timezone math, matching how banks report transactions.
 */

export type RecurrenceInterval = "weekly" | "monthly" | "quarterly" | "yearly";

export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = fromIsoDate(iso);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

/** Add months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsClamped(iso: string, months: number): string {
  const d = fromIsoDate(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return toIsoDate(d);
}

export function addInterval(iso: string, interval: RecurrenceInterval): string {
  switch (interval) {
    case "weekly":
      return addDays(iso, 7);
    case "monthly":
      return addMonthsClamped(iso, 1);
    case "quarterly":
      return addMonthsClamped(iso, 3);
    case "yearly":
      return addMonthsClamped(iso, 12);
  }
}

/** First and last day of the month containing `iso`. */
export function monthRange(iso: string): { start: string; end: string } {
  const d = fromIsoDate(iso);
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

/**
 * The financial year containing `iso`, given the 1-12 month it starts in
 * (India = 4 → Apr–Mar). Returns inclusive ISO bounds and a display label:
 * "FY 2026–27" for an offset year, or "2026" when it's the calendar year.
 */
export function financialYearRange(
  iso: string,
  startMonth: number,
): { start: string; end: string; label: string } {
  const d = fromIsoDate(iso);
  const month = d.getMonth() + 1; // 1-12
  const startYear = month >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
  const start = new Date(startYear, startMonth - 1, 1);
  const end = new Date(startYear + 1, startMonth - 1, 0); // day before next FY start
  const label =
    startMonth === 1
      ? `${startYear}`
      : `FY ${startYear}–${String(startYear + 1).slice(2)}`;
  return { start: toIsoDate(start), end: toIsoDate(end), label };
}

export function isBefore(a: string, b: string): boolean {
  return a < b;
}

export function daysBetween(a: string, b: string): number {
  const ms = fromIsoDate(b).getTime() - fromIsoDate(a).getTime();
  return Math.round(ms / 86_400_000);
}

const DATE_PATTERNS: Array<{
  format: string;
  regex: RegExp;
  build: (m: RegExpMatchArray) => { y: number; mo: number; d: number };
}> = [
  {
    format: "yyyy-MM-dd",
    regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    build: (m) => ({ y: +m[1]!, mo: +m[2]!, d: +m[3]! }),
  },
  {
    format: "dd/MM/yyyy",
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    build: (m) => ({ y: +m[3]!, mo: +m[2]!, d: +m[1]! }),
  },
  {
    format: "MM/dd/yyyy",
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    build: (m) => ({ y: +m[3]!, mo: +m[1]!, d: +m[2]! }),
  },
  {
    format: "dd-MM-yyyy",
    regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    build: (m) => ({ y: +m[3]!, mo: +m[2]!, d: +m[1]! }),
  },
  {
    format: "dd/MM/yy",
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
    build: (m) => ({ y: 2000 + +m[3]!, mo: +m[2]!, d: +m[1]! }),
  },
  {
    format: "dd MMM yyyy",
    regex: /^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{4})$/,
    build: (m) => ({
      y: +m[3]!,
      mo: monthNameToNumber(m[2]!),
      d: +m[1]!,
    }),
  },
];

function monthNameToNumber(name: string): number {
  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const idx = months.indexOf(name.slice(0, 3).toLowerCase());
  return idx === -1 ? NaN : idx + 1;
}

export const SUPPORTED_DATE_FORMATS = DATE_PATTERNS.map((p) => p.format).filter(
  (f, i, arr) => arr.indexOf(f) === i,
);

function isValidYmd(y: number, mo: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) {
    return false;
  }
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(y, mo, 0).getDate();
}

/**
 * Parse a date string into ISO `yyyy-MM-dd`. When `preferredFormat` is given
 * (from the import mapping), it is tried first; otherwise formats are tried
 * in order, preferring day-first interpretation (india-first).
 */
export function parseDateString(
  input: string,
  preferredFormat?: string,
): string | null {
  const s = input.trim();
  if (!s) return null;
  const patterns = preferredFormat
    ? [
        ...DATE_PATTERNS.filter((p) => p.format === preferredFormat),
        ...DATE_PATTERNS.filter((p) => p.format !== preferredFormat),
      ]
    : DATE_PATTERNS;
  for (const pattern of patterns) {
    const m = s.match(pattern.regex);
    if (!m) continue;
    const { y, mo, d } = pattern.build(m);
    if (!isValidYmd(y, mo, d)) continue;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}
