import { describe, expect, it } from "vitest";
import {
  matchSelfTransfers,
  SELF_TRANSFER_WINDOW_DAYS,
  type SelfTransferLeg,
} from "./self-transfers";

const out = (overrides: Partial<SelfTransferLeg> = {}): SelfTransferLeg => ({
  transactionId: "out-1",
  accountId: "inter",
  date: "2026-09-05",
  amountMinor: -219406,
  ...overrides,
});

const inn = (overrides: Partial<SelfTransferLeg> = {}): SelfTransferLeg => ({
  transactionId: "in-1",
  accountId: "santander",
  date: "2026-09-05",
  amountMinor: 219406,
  ...overrides,
});

describe("matchSelfTransfers", () => {
  it("pairs the two sides of one movement between own accounts", () => {
    expect(matchSelfTransfers([out(), inn()])).toEqual([
      {
        kind: "matched",
        outflowTransactionId: "out-1",
        inflowTransactionId: "in-1",
        inflowAccountId: "santander",
        amountMinor: 219406,
      },
    ]);
  });

  it("tolerates the legs landing on different calendar days", () => {
    for (const offset of ["2026-09-03", "2026-09-07"]) {
      expect(matchSelfTransfers([out(), inn({ date: offset })])[0]).toMatchObject({
        kind: "matched",
      });
    }
  });

  it("leaves legs further apart than the window alone", () => {
    expect(matchSelfTransfers([out(), inn({ date: "2026-09-08" })])[0]).toEqual({
      kind: "unmatched",
      outflowTransactionId: "out-1",
    });
    expect(SELF_TRANSFER_WINDOW_DAYS).toBe(2);
  });

  it("requires the amount to match exactly", () => {
    expect(matchSelfTransfers([out(), inn({ amountMinor: 219405 })])[0]).toMatchObject({
      kind: "unmatched",
    });
  });

  it("never pairs a row with a leg on its own account", () => {
    expect(matchSelfTransfers([out(), inn({ accountId: "inter" })])[0]).toMatchObject({
      kind: "unmatched",
    });
  });

  it("leaves real income from a third party alone", () => {
    // Money in with no matching debit anywhere is income, which is exactly what
    // this must not touch.
    expect(matchSelfTransfers([inn({ transactionId: "salary", amountMinor: 608000 })])).toEqual(
      [],
    );
  });

  it("reports two plausible destinations rather than choosing", () => {
    const decisions = matchSelfTransfers([
      out(),
      inn({ transactionId: "in-a", accountId: "santander" }),
      inn({ transactionId: "in-b", accountId: "nubank" }),
    ]);
    expect(decisions[0]).toEqual({
      kind: "ambiguous",
      outflowTransactionId: "out-1",
      inflowAccountIds: ["santander", "nubank"],
    });
  });

  it("picks the closest date when the candidates share one account", () => {
    // Either choice produces the same ledger, so this is a tie worth breaking
    // rather than an ambiguity worth escalating.
    const decisions = matchSelfTransfers([
      out(),
      inn({ transactionId: "in-far", date: "2026-09-07" }),
      inn({ transactionId: "in-near", date: "2026-09-05" }),
    ]);
    expect(decisions[0]).toMatchObject({ kind: "matched", inflowTransactionId: "in-near" });
  });

  it("prefers a leg the provider called a same-holder movement", () => {
    const decisions = matchSelfTransfers([
      out(),
      inn({ transactionId: "third-party", accountId: "nubank" }),
      inn({ transactionId: "own", accountId: "santander", sameOwnerHint: true }),
    ]);
    expect(decisions[0]).toMatchObject({ kind: "matched", inflowTransactionId: "own" });
  });

  it("pairs without the hint, because the provider does not always give one", () => {
    // The R$ 6.080 case: labelled only `Transfer - PIX`, indistinguishable from
    // money sent by someone else, yet the debit leg is right there.
    const decisions = matchSelfTransfers([
      out({ amountMinor: -608000 }),
      inn({ amountMinor: 608000 }),
    ]);
    expect(decisions[0]).toMatchObject({ kind: "matched" });
  });

  it("never lets two outflows claim the same inflow", () => {
    const decisions = matchSelfTransfers([
      out({ transactionId: "out-a" }),
      out({ transactionId: "out-b" }),
      inn(),
    ]);
    expect(decisions.filter((d) => d.kind === "matched")).toHaveLength(1);
    expect(decisions.filter((d) => d.kind === "unmatched")).toHaveLength(1);
  });

  it("pairs repeated movements of the same value one for one", () => {
    const decisions = matchSelfTransfers([
      out({ transactionId: "out-a", date: "2026-09-05" }),
      out({ transactionId: "out-b", date: "2026-09-06" }),
      inn({ transactionId: "in-a", date: "2026-09-05" }),
      inn({ transactionId: "in-b", date: "2026-09-06" }),
    ]);
    expect(decisions).toEqual([
      expect.objectContaining({
        kind: "matched",
        outflowTransactionId: "out-a",
        inflowTransactionId: "in-a",
      }),
      expect.objectContaining({
        kind: "matched",
        outflowTransactionId: "out-b",
        inflowTransactionId: "in-b",
      }),
    ]);
  });

  it("decides the same way whatever order the rows arrive in", () => {
    const legs = [
      out({ transactionId: "out-a", date: "2026-09-06" }),
      inn({ transactionId: "in-a", date: "2026-09-05" }),
      out({ transactionId: "out-b", date: "2026-09-05" }),
      inn({ transactionId: "in-b", date: "2026-09-06" }),
    ];
    const forward = matchSelfTransfers(legs);
    const reversed = matchSelfTransfers([...legs].reverse());
    expect(reversed).toEqual(forward);
  });

  it("returns nothing to do when there is no money moving out", () => {
    expect(matchSelfTransfers([])).toEqual([]);
  });
});
