import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv } from "./csv";

describe("parseCsv", () => {
  it("parses a simple file", () => {
    const { headers, rows } = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(headers).toEqual(["a", "b", "c"]);
    expect(rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
  });

  it("handles quoted fields with commas, quotes, and newlines", () => {
    const text = 'name,memo\n"Doe, John","He said ""hi""\nand left"\n';
    const { rows } = parseCsv(text);
    expect(rows[0]).toEqual({ name: "Doe, John", memo: 'He said "hi"\nand left' });
  });

  it("handles CRLF and BOM", () => {
    const { headers, rows } = parseCsv("﻿date,amt\r\n01/02/2026,5\r\n");
    expect(headers).toEqual(["date", "amt"]);
    expect(rows).toHaveLength(1);
  });

  it("pads short rows and skips blank lines", () => {
    const { rows } = parseCsv("a,b\n1\n\n2,3\n");
    expect(rows).toEqual([
      { a: "1", b: "" },
      { a: "2", b: "3" },
    ]);
  });

  it("names empty headers", () => {
    const { headers } = parseCsv("a,,c\n1,2,3");
    expect(headers).toEqual(["a", "column_2", "c"]);
  });

  it("throws on unterminated quotes and empty input", () => {
    expect(() => parseCsv('a,b\n"oops')).toThrow(CsvParseError);
    expect(() => parseCsv("")).toThrow(CsvParseError);
  });
});
