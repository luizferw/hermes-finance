import { describe, expect, it } from "vitest";
import {
  matchCardPayment,
  matchCardPayments,
  type BankOutflow,
  type CardPaymentLeg,
} from "./card-payments";

const leg = (overrides: Partial<CardPaymentLeg> = {}): CardPaymentLeg => ({
  cardAccountId: "card-a",
  date: "2026-03-07",
  amountMinor: 388594,
  ...overrides,
});

const outflow = (overrides: Partial<BankOutflow> = {}): BankOutflow => ({
  transactionId: "tx-1",
  date: "2026-03-07",
  amountMinor: -388594,
  ...overrides,
});

describe("matchCardPayment", () => {
  it("points the bank outflow at the card whose bill it paid", () => {
    expect(matchCardPayment(outflow(), [leg()])).toEqual({
      kind: "matched",
      transactionId: "tx-1",
      cardAccountId: "card-a",
    });
  });

  it("tolerates a couple of days between the two legs", () => {
    expect(matchCardPayment(outflow({ date: "2026-03-09" }), [leg()])).toMatchObject({
      kind: "matched",
    });
    expect(matchCardPayment(outflow({ date: "2026-03-05" }), [leg()])).toMatchObject({
      kind: "matched",
    });
  });

  it("will not reach further than the window", () => {
    expect(matchCardPayment(outflow({ date: "2026-03-10" }), [leg()])).toMatchObject({
      kind: "unmatched",
    });
  });

  it("requires the amount to be exactly equal", () => {
    // This is the same money seen from both sides, so "close" is not a match.
    expect(matchCardPayment(outflow({ amountMinor: -388593 }), [leg()])).toMatchObject({
      kind: "unmatched",
    });
  });

  it("refuses to choose between two cards that both fit", () => {
    const decision = matchCardPayment(outflow(), [leg(), leg({ cardAccountId: "card-b" })]);
    expect(decision).toEqual({
      kind: "ambiguous",
      transactionId: "tx-1",
      cardAccountIds: ["card-a", "card-b"],
    });
  });

  it("stays matched when the same card reports the leg twice", () => {
    // Duplicate legs on one card are still one answer, not an ambiguity.
    expect(matchCardPayment(outflow(), [leg(), leg({ date: "2026-03-08" })])).toMatchObject({
      kind: "matched",
      cardAccountId: "card-a",
    });
  });

  it("reports no match rather than inventing one", () => {
    expect(matchCardPayment(outflow(), [])).toEqual({ kind: "unmatched", transactionId: "tx-1" });
  });
});

describe("matchCardPayments", () => {
  it("never lets one payment settle two bills", () => {
    // Two outflows of the same value days apart, but only one card payment
    // actually happened: the second must not claim the same leg.
    const results = matchCardPayments(
      [outflow({ transactionId: "tx-1" }), outflow({ transactionId: "tx-2", date: "2026-03-08" })],
      [leg()],
    );
    expect(results.filter((result) => result.kind === "matched")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "unmatched")).toHaveLength(1);
  });

  it("settles two real payments against two legs", () => {
    const results = matchCardPayments(
      [
        outflow({ transactionId: "tx-1" }),
        outflow({ transactionId: "tx-2", date: "2026-03-08" }),
      ],
      [leg(), leg({ date: "2026-03-08" })],
    );
    expect(results.every((result) => result.kind === "matched")).toBe(true);
  });

  it("gives each outflow the closest leg", () => {
    const results = matchCardPayments(
      [
        outflow({ transactionId: "far", date: "2026-03-09" }),
        outflow({ transactionId: "near", date: "2026-03-07" }),
      ],
      [leg({ cardAccountId: "card-a", date: "2026-03-07" })],
    );
    // Processed oldest first, so the outflow sitting on the leg's own date wins.
    const matched = results.find((result) => result.kind === "matched");
    expect(matched).toMatchObject({ transactionId: "near", cardAccountId: "card-a" });
  });

  it("keeps two different cards apart", () => {
    const results = matchCardPayments(
      [
        outflow({ transactionId: "tx-1", amountMinor: -100000 }),
        outflow({ transactionId: "tx-2", amountMinor: -250000 }),
      ],
      [
        leg({ cardAccountId: "card-a", amountMinor: 100000 }),
        leg({ cardAccountId: "card-b", amountMinor: 250000 }),
      ],
    );
    expect(results).toEqual([
      { kind: "matched", transactionId: "tx-1", cardAccountId: "card-a" },
      { kind: "matched", transactionId: "tx-2", cardAccountId: "card-b" },
    ]);
  });
});
