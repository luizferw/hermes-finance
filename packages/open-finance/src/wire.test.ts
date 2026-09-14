import { describe, expect, it } from "vitest";
import {
  parseAccount,
  parseAuthResponse,
  parseBill,
  parseCursorPage,
  parseItem,
  parseResults,
  parseTransaction,
  PluggyPayloadError,
} from "./wire";

describe("parseAuthResponse", () => {
  it("reads the api key", () => {
    expect(parseAuthResponse({ apiKey: "abc" })).toEqual({ apiKey: "abc" });
  });

  it("refuses a response without one", () => {
    expect(() => parseAuthResponse({})).toThrow(PluggyPayloadError);
    expect(() => parseAuthResponse({ apiKey: "" })).toThrow(/non-empty string/);
    expect(() => parseAuthResponse(null)).toThrow(/expected an object/);
  });
});

describe("parseItem", () => {
  it("flattens the connector and the error code", () => {
    const item = parseItem({
      id: "item-1",
      status: "UPDATED",
      executionStatus: "SUCCESS",
      lastUpdatedAt: "2026-03-10T09:00:00.000Z",
      consentExpiresAt: null,
      connector: { id: 201, name: "Nubank", imageUrl: "https://x/y.png" },
      error: { code: "LOGIN_ERROR", message: "senha inválida" },
    });

    expect(item).toMatchObject({
      id: "item-1",
      status: "UPDATED",
      lastUpdatedAt: "2026-03-10T09:00:00.000Z",
      consentExpiresAt: null,
      errorCode: "LOGIN_ERROR",
    });
    expect(item.connector).toMatchObject({ id: 201, name: "Nubank" });
  });

  it("falls back to updatedAt when lastUpdatedAt is absent", () => {
    const item = parseItem({ id: "item-1", updatedAt: "2026-03-09T10:00:00.000Z" });
    expect(item.lastUpdatedAt).toBe("2026-03-09T10:00:00.000Z");
  });

  it("tolerates fields Pluggy adds that we do not read", () => {
    const item = parseItem({ id: "item-1", somethingBrandNew: { nested: true } });
    expect(item.id).toBe("item-1");
  });
});

describe("parseAccount", () => {
  it("reads a credit account with its credit data", () => {
    const account = parseAccount(
      {
        id: "acc-1",
        type: "CREDIT",
        subtype: "CREDIT_CARD",
        number: "1234",
        name: "Itau Platinum",
        balance: 142.41,
        currencyCode: "BRL",
        creditData: { brand: "MASTERCARD", creditLimit: 518, balanceDueDate: "2026-03-17" },
      },
      0,
    );

    expect(account.balance).toBe(142.41);
    expect(account.creditData).toMatchObject({ brand: "MASTERCARD", creditLimit: 518 });
    expect(account.creditData?.minimumPayment).toBeNull();
  });

  it("names the offending record when a required field is wrong", () => {
    expect(() => parseAccount({ id: "acc-1", type: "BANK", balance: "120,00" }, 3)).toThrow(
      /accounts\[3\]\.balance: expected a finite number/,
    );
  });
});

describe("parseTransaction", () => {
  it("flattens merchant, payment reason and card metadata", () => {
    const transaction = parseTransaction(
      {
        id: "txn-1",
        accountId: "acc-1",
        description: "Padaria",
        amount: -25.5,
        date: "2026-03-10T00:00:00.000Z",
        status: "POSTED",
        merchant: { name: "Zé Pães", cnpj: "00.000.000/0001-00" },
        paymentData: { reason: "Pagamento de fatura" },
        creditCardMetadata: { installmentNumber: 3, totalInstallments: 6, billId: "bill-2" },
      },
      0,
    );

    expect(transaction).toMatchObject({
      merchantName: "Zé Pães",
      paymentReason: "Pagamento de fatura",
    });
    expect(transaction.creditCardMetadata).toMatchObject({
      installmentNumber: 3,
      totalInstallments: 6,
      billId: "bill-2",
    });
  });

  it("ignores a non-integer installment count rather than trusting it", () => {
    const transaction = parseTransaction(
      {
        id: "txn-1",
        amount: 1,
        date: "2026-03-10T00:00:00.000Z",
        creditCardMetadata: { installmentNumber: 1.5, totalInstallments: 6 },
      },
      0,
    );
    expect(transaction.creditCardMetadata?.installmentNumber).toBeNull();
  });

  it("refuses a transaction with no date", () => {
    expect(() => parseTransaction({ id: "txn-1", amount: 1 }, 0)).toThrow(
      /transactions\[0\]\.date/,
    );
  });
});

describe("parseBill", () => {
  it("reads the payments array", () => {
    const bill = parseBill(
      {
        id: "bill-1",
        dueDate: "2026-03-15T00:00:00.000Z",
        totalAmount: 1000.76,
        payments: [{ paymentDate: "2026-03-14T00:00:00.000Z", amount: 1000.76 }],
      },
      0,
    );
    expect(bill.payments).toHaveLength(1);
    expect(bill.minimumPaymentAmount).toBeNull();
  });

  it("treats a missing payments array as no payments", () => {
    const bill = parseBill({ id: "bill-1", dueDate: "2026-03-15", totalAmount: 10 }, 0);
    expect(bill.payments).toEqual([]);
  });
});

describe("page shapes", () => {
  it("maps every result with its index", () => {
    const accounts = parseResults(
      { results: [{ id: "a", type: "BANK", balance: 1 }] },
      "accounts",
      parseAccount,
    );
    expect(accounts).toHaveLength(1);
  });

  it("reads the cursor of a transactions page", () => {
    const page = parseCursorPage(
      { results: [], next: "?accountId=acc-1&after=X" },
      "transactions",
      parseTransaction,
    );
    expect(page).toEqual({ results: [], next: "?accountId=acc-1&after=X" });
  });

  it("reports a missing results array instead of returning nothing", () => {
    expect(() => parseResults({}, "accounts", parseAccount)).toThrow(
      /accounts\.results: expected an array/,
    );
  });
});
