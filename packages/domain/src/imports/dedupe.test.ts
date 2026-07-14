import { describe, expect, it } from "vitest";
import {
  computeImportHash,
  findDuplicate,
  findIntraBatchDuplicates,
  normalizeDescription,
} from "./dedupe";

const acct = "00000000-0000-0000-0000-000000000001";

describe("computeImportHash", () => {
  it("is stable and case/whitespace-insensitive on description", () => {
    const a = computeImportHash({
      accountId: acct,
      date: "2026-01-05",
      amountMinor: -45000,
      description: "UPI-SWIGGY  Bangalore",
    });
    const b = computeImportHash({
      accountId: acct,
      date: "2026-01-05",
      amountMinor: -45000,
      description: "upi-swiggy bangalore",
    });
    expect(a).toBe(b);
    expect(normalizeDescription("  A  B ")).toBe("a b");
  });

  it("changes when any component changes", () => {
    const base = { accountId: acct, date: "2026-01-05", amountMinor: -45000, description: "x" };
    expect(computeImportHash(base)).not.toBe(computeImportHash({ ...base, amountMinor: -45001 }));
    expect(computeImportHash(base)).not.toBe(computeImportHash({ ...base, date: "2026-01-06" }));
  });
});

describe("findDuplicate", () => {
  const existing = [
    {
      id: "t1",
      date: "2026-01-05",
      amountMinor: -45000,
      importHash: computeImportHash({
        accountId: acct,
        date: "2026-01-05",
        amountMinor: -45000,
        description: "UPI-SWIGGY",
      }),
      externalId: "REF123",
    },
  ];

  it("matches by external id first", () => {
    const match = findDuplicate(
      acct,
      { date: "2026-01-07", amountMinor: -1, description: "different", externalId: "REF123" },
      existing,
    );
    expect(match).toEqual({ kind: "exact", transactionId: "t1", reason: "external_id" });
  });

  it("matches by hash", () => {
    const match = findDuplicate(
      acct,
      { date: "2026-01-05", amountMinor: -45000, description: "upi-swiggy", externalId: null },
      existing,
    );
    expect(match).toEqual({ kind: "exact", transactionId: "t1", reason: "hash" });
  });

  it("finds fuzzy matches within one day on the same amount", () => {
    const match = findDuplicate(
      acct,
      { date: "2026-01-06", amountMinor: -45000, description: "something else", externalId: null },
      existing,
    );
    expect(match).toEqual({ kind: "fuzzy", transactionId: "t1", reason: "amount_near_date" });
  });

  it("returns null when nothing matches", () => {
    const match = findDuplicate(
      acct,
      { date: "2026-02-01", amountMinor: -999, description: "nope", externalId: null },
      existing,
    );
    expect(match).toBeNull();
  });
});

describe("findIntraBatchDuplicates", () => {
  it("flags later occurrences of identical rows", () => {
    const rows = [
      { date: "2026-01-05", amountMinor: -45000, description: "swiggy", externalId: null },
      { date: "2026-01-05", amountMinor: -45000, description: "SWIGGY", externalId: null },
      { date: "2026-01-06", amountMinor: -100, description: "other", externalId: null },
    ];
    expect(findIntraBatchDuplicates(acct, rows)).toEqual(new Set([1]));
  });
});
