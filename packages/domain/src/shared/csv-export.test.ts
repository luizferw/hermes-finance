import { describe, expect, it } from "vitest";
import { toCsv } from "./csv-export";

describe("toCsv", () => {
  it("joins headers and rows with CRLF", () => {
    expect(toCsv(["a", "b"], [[1, 2], [3, 4]])).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("quotes fields with commas, quotes, or newlines and doubles quotes", () => {
    expect(toCsv(["x"], [["a,b"]])).toBe('x\r\n"a,b"');
    expect(toCsv(["x"], [['he said "hi"']])).toBe('x\r\n"he said ""hi"""');
    expect(toCsv(["x"], [["line1\nline2"]])).toBe('x\r\n"line1\nline2"');
  });

  it("renders null/undefined as empty", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,");
  });
});
