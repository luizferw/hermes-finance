import { describe, expect, it } from "vitest";
import {
  hermesAccountTypeFor,
  lastFourDigits,
  matchAccountCandidate,
  normalizeName,
  proposeAccountName,
  uniqueAccountName,
  type AccountMatchCandidate,
  type AccountMatchInput,
} from "./matching";

function candidate(overrides: Partial<AccountMatchCandidate> = {}): AccountMatchCandidate {
  return {
    accountId: "acc-hermes",
    name: "Nubank Conta",
    institution: "Nubank",
    numberMask: "1234",
    currencyCode: "BRL",
    type: "asset",
    ...overrides,
  };
}

function incoming(overrides: Partial<AccountMatchInput> = {}): AccountMatchInput {
  return {
    name: "Conta Corrente",
    connectorName: "Nubank",
    numberMask: "0001/12345-1234",
    currencyCode: "BRL",
    hermesType: "asset",
    ...overrides,
  };
}

describe("hermesAccountTypeFor", () => {
  it("maps the account kinds Hermes models", () => {
    expect(hermesAccountTypeFor("BANK", "CHECKING_ACCOUNT")).toBe("asset");
    expect(hermesAccountTypeFor("BANK", "SAVINGS_ACCOUNT")).toBe("asset");
    expect(hermesAccountTypeFor("CREDIT", "CREDIT_CARD")).toBe("credit_card");
    expect(hermesAccountTypeFor("bank", null)).toBe("asset");
  });

  it("refuses the ones it has no model for, rather than guessing", () => {
    expect(hermesAccountTypeFor("INVESTMENT", null)).toBeNull();
    expect(hermesAccountTypeFor("LOAN", null)).toBeNull();
    expect(hermesAccountTypeFor("BANK", "PAYMENT_ACCOUNT")).toBeNull();
  });
});

describe("lastFourDigits", () => {
  it("reduces every way a number gets written to the same tail", () => {
    expect(lastFourDigits("****1234")).toBe("1234");
    expect(lastFourDigits("1234")).toBe("1234");
    expect(lastFourDigits("0001/12345-1234")).toBe("1234");
    expect(lastFourDigits("XXXX-1234")).toBe("1234");
  });

  it("declines to match on something too short to be distinctive", () => {
    expect(lastFourDigits("123")).toBeNull();
    expect(lastFourDigits("")).toBeNull();
    expect(lastFourDigits(null)).toBeNull();
  });
});

describe("normalizeName", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normalizeName("Itaú  Uniclass 2.0!")).toBe("itau uniclass 2 0");
  });
});

describe("matchAccountCandidate", () => {
  it("matches on the number tail plus the institution", () => {
    const decision = matchAccountCandidate(incoming(), [candidate()]);
    expect(decision).toMatchObject({ kind: "match", accountId: "acc-hermes", confidence: "exact_mask" });
  });

  it("still matches on the tail alone when the names share nothing", () => {
    const decision = matchAccountCandidate(incoming(), [
      candidate({ name: "Principal", institution: null }),
    ]);
    expect(decision).toMatchObject({ kind: "match", confidence: "institution_mask" });
  });

  it("falls back to the name when no number is available", () => {
    const decision = matchAccountCandidate(
      incoming({ numberMask: null, name: "Nubank Conta" }),
      [candidate({ numberMask: null })],
    );
    expect(decision).toMatchObject({ kind: "match", confidence: "name" });
  });

  it("treats currency and type as hard gates", () => {
    expect(matchAccountCandidate(incoming(), [candidate({ currencyCode: "USD" })])).toMatchObject({
      kind: "create",
    });
    expect(matchAccountCandidate(incoming(), [candidate({ type: "credit_card" })])).toMatchObject({
      kind: "create",
    });
  });

  it("refuses to choose between two plausible candidates", () => {
    const decision = matchAccountCandidate(incoming(), [
      candidate({ accountId: "a" }),
      candidate({ accountId: "b", name: "Nubank Reserva" }),
    ]);
    expect(decision).toMatchObject({ kind: "ambiguous", candidateIds: ["a", "b"] });
  });

  it("creates when there is nothing to match against", () => {
    expect(matchAccountCandidate(incoming(), [])).toMatchObject({ kind: "create" });
    expect(
      matchAccountCandidate(incoming({ numberMask: "9999" }), [
        candidate({ name: "Banco do Brasil", institution: "BB", numberMask: "5555" }),
      ]),
    ).toMatchObject({ kind: "create" });
  });

  it("explains itself, because the user has to be able to override it", () => {
    const decision = matchAccountCandidate(incoming(), [candidate()]);
    expect(decision.note).toContain("Nubank Conta");
    expect(decision.note).toContain("1234");
  });
});

describe("uniqueAccountName", () => {
  it("leaves a free name alone", () => {
    expect(uniqueAccountName("Nubank", new Set())).toBe("Nubank");
  });

  it("walks past collisions", () => {
    expect(uniqueAccountName("Nubank", new Set(["Nubank"]))).toBe("Nubank (2)");
    expect(uniqueAccountName("Nubank", new Set(["Nubank", "Nubank (2)"]))).toBe("Nubank (3)");
  });

  it("never returns an empty name", () => {
    expect(uniqueAccountName("   ", new Set())).toBe("Account");
  });
});

describe("proposeAccountName", () => {
  it("prefixes the institution and suffixes the number tail", () => {
    expect(
      proposeAccountName({
        connectorName: "Nubank",
        providerName: "Conta Corrente",
        numberMask: "1234",
      }),
    ).toBe("Nubank Conta Corrente (1234)");
  });

  it("does not repeat an institution the provider name already carries", () => {
    expect(
      proposeAccountName({
        connectorName: "Itaú",
        providerName: "Itaú Uniclass Platinum",
        numberMask: "5678",
      }),
    ).toBe("Itaú Uniclass Platinum (5678)");
  });

  it("copes with no connector and no number", () => {
    expect(
      proposeAccountName({ connectorName: null, providerName: "Conta", numberMask: null }),
    ).toBe("Conta");
  });
});
