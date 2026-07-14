/**
 * Minimal, dependency-free RFC 4180 CSV parser. Handles quoted fields,
 * escaped quotes, CRLF/LF, BOM, and trailing newlines. Intentionally does
 * not stream — bank statements are small files.
 */

export interface ParsedCsv {
  headers: string[];
  /** Rows as objects keyed by header name. Short rows are padded with "". */
  rows: Array<Record<string, string>>;
}

export class CsvParseError extends Error {}

export function parseCsv(text: string, delimiter = ","): ParsedCsv {
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1); // strip BOM

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    // Skip records that are entirely empty (trailing newline, blank lines).
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field === "") {
        inQuotes = true;
        i += 1;
        continue;
      }
      // Quote inside an unquoted field — tolerate it literally.
      field += ch;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (input[i + 1] === "\n") i += 1;
      pushRecord();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) throw new CsvParseError("Unterminated quoted field");
  if (field !== "" || record.length > 0) pushRecord();

  if (records.length === 0) {
    throw new CsvParseError("File contains no rows");
  }

  const headerRow = records[0]!;
  const headers = headerRow.map((h, idx) => {
    const name = h.trim();
    return name === "" ? `column_${idx + 1}` : name;
  });

  const rows = records.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = (cells[idx] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}
