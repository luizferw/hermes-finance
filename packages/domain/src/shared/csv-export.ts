/**
 * Minimal RFC-4180 CSV serializer. A field is quoted only when it contains a
 * comma, quote, or newline; embedded quotes are doubled. Enough for data
 * export — no streaming, no dependency.
 */

export type CsvValue = string | number | null | undefined;

function escapeField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers.map(escapeField).join(",")];
  for (const row of rows) lines.push(row.map(escapeField).join(","));
  return lines.join("\r\n");
}
