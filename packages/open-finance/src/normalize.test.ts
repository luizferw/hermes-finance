import { describe, expect, it } from "vitest";
import {
  accountKindOf,
  amountToMinor,
  brazilianCalendarDay,
  looksLikeCardBillPayment,
  normalizeAccount,
  normalizeBill,
  normalizeTransaction,
  statusFor,
  type NormalizeContext,
} from "./normalize";
import type {
  PluggyAccount,
  PluggyBill,
  PluggyCreditCardMetadata,
  PluggyTransaction,
} from "./wire";

const EXPONENTS: Record<string, number> = { BRL: 2, USD: 2, JPY: 0, KWD: 3 };

const context: NormalizeContext = {
  minorUnitExponent: (code) => EXPONENTS[code.toUpperCase()] ?? 2,
  defaultCurrencyCode: "BRL",
};

type TransactionOverrides = Partial<Omit<PluggyTransaction, "creditCardMetadata">> & {
  creditCardMetadata?: Partial<PluggyCreditCardMetadata>;
};

function transaction(overrides: TransactionOverrides = {}): PluggyTransaction {
  return {
    id: "txn-1",
    accountId: "acc-1",
    description: "Padaria",
    amount: 25.5,
    date: "2026-03-10T00:00:00.000Z",
    currencyCode: "BRL",
    status: "POSTED",
    ...overrides,
  } as PluggyTransaction;
}

describe("amountToMinor", () => {
  it("converts the floats Pluggy actually sends without drifting a cent", () => {
    expect(amountToMinor(142.41, 2)).toBe(14241);
    expect(amountToMinor(10000.76, 2)).toBe(1000076);
    expect(amountToMinor(1500, 2)).toBe(150000);
    expect(amountToMinor(0, 2)).toBe(0);
  });

  it("survives values that binary floating point cannot represent exactly", () => {
    // 0.1 + 0.2 === 0.30000000000000004; multiplying by 100 gives 30.000000000000004.
    expect(amountToMinor(0.1 + 0.2, 2)).toBe(30);
    expect(amountToMinor(1.005, 2)).toBe(101);
    expect(amountToMinor(8.115, 2)).toBe(812);
  });

  it("rounds away from zero on both signs", () => {
    expect(amountToMinor(-1.005, 2)).toBe(-101);
    expect(amountToMinor(-142.41, 2)).toBe(-14241);
  });

  it("respects the currency exponent", () => {
    expect(amountToMinor(1234, 0)).toBe(1234);
    expect(amountToMinor(1234.9, 0)).toBe(1235);
    expect(amountToMinor(1.2345, 3)).toBe(1235);
  });

  it("handles values serialized in scientific notation", () => {
    expect(amountToMinor(1e-7, 2)).toBe(0);
    expect(amountToMinor(1.5e3, 2)).toBe(150000);
  });

  it("refuses values it cannot represent faithfully", () => {
    expect(() => amountToMinor(Number.NaN, 2)).toThrow(/finite/);
    expect(() => amountToMinor(1, 9)).toThrow(/exponent/);
    expect(() => amountToMinor(1e17, 2)).toThrow(/safe integer/);
  });
});

describe("brazilianCalendarDay", () => {
  it("reads a bare date sent as midnight UTC as that date", () => {
    // Shifting this to GMT-3 would move every posted transaction one day back.
    expect(brazilianCalendarDay("2021-04-12T00:00:00.000Z")).toBe("2021-04-12");
  });

  it("shifts a real instant into Brazilian time", () => {
    expect(brazilianCalendarDay("2026-03-11T02:30:00.000Z")).toBe("2026-03-10");
    expect(brazilianCalendarDay("2026-03-10T12:00:00.000Z")).toBe("2026-03-10");
  });

  it("rejects garbage rather than inventing a date", () => {
    expect(() => brazilianCalendarDay("not a date")).toThrow(/invalid ISO/);
  });
});

describe("normalizeAccount", () => {
  const bank: PluggyAccount = {
    id: "acc-bank",
    type: "BANK",
    subtype: "CHECKING_ACCOUNT",
    number: "0001/12345-0",
    name: "Conta Corrente",
    balance: 1209.5,
    currencyCode: "BRL",
  } as PluggyAccount;

  const card: PluggyAccount = {
    id: "acc-card",
    type: "CREDIT",
    subtype: "CREDIT_CARD",
    number: "1234",
    name: "Itau Platinum",
    balance: 142.41,
    currencyCode: "BRL",
    creditData: {
      brand: "MASTERCARD",
      balanceCloseDate: "2026-03-08",
      balanceDueDate: "2026-03-17",
      availableCreditLimit: 513,
      creditLimit: 518,
      minimumPayment: 100,
    },
  } as PluggyAccount;

  it("classifies the account kind", () => {
    expect(accountKindOf(bank)).toBe("bank");
    expect(accountKindOf(card)).toBe("credit");
  });

  it("keeps a bank balance as reported", () => {
    expect(normalizeAccount(bank, context).balanceMinor).toBe(120950);
  });

  it("negates a card balance, because an open bill is a debt", () => {
    const normalized = normalizeAccount(card, context);
    expect(normalized.balanceMinor).toBe(-14241);
    expect(normalized.creditLimitMinor).toBe(51800);
    expect(normalized.availableCreditMinor).toBe(51300);
    expect(normalized.closingDay).toBe(8);
    expect(normalized.dueDay).toBe(17);
    expect(normalized.brand).toBe("MASTERCARD");
    expect(normalized.numberMask).toBe("1234");
  });

  it("leaves card fields null on a bank account", () => {
    const normalized = normalizeAccount(bank, context);
    expect(normalized.creditLimitMinor).toBeNull();
    expect(normalized.closingDay).toBeNull();
  });
});

describe("normalizeTransaction", () => {
  it("maps a bank credit to income and a bank debit to expense", () => {
    const income = normalizeTransaction(transaction({ amount: 1500 }), "bank", context);
    expect(income).toMatchObject({ kind: "transaction", type: "income", amountMinor: 150000 });

    const expense = normalizeTransaction(transaction({ amount: -75.9 }), "bank", context);
    expect(expense).toMatchObject({ kind: "transaction", type: "expense", amountMinor: -7590 });
  });

  it("inverts the sign on a card, where a positive amount is a purchase", () => {
    const purchase = normalizeTransaction(transaction({ amount: 89.9 }), "credit", context);
    expect(purchase).toMatchObject({ kind: "transaction", type: "expense", amountMinor: -8990 });
  });

  it("skips the bill payment leg on a card instead of booking a second expense", () => {
    const payment = normalizeTransaction(transaction({ amount: -1000 }), "credit", context);
    expect(payment).toEqual({
      kind: "skipped",
      externalId: "txn-1",
      reason: "card_payment_leg",
    });
  });

  it("skips a zero amount, which no ledger sign check would accept", () => {
    const zero = normalizeTransaction(transaction({ amount: 0 }), "bank", context);
    expect(zero).toEqual({ kind: "skipped", externalId: "txn-1", reason: "zero_amount" });
  });

  it("keeps a pending bank authorization out of the balance", () => {
    const pending = normalizeTransaction(
      transaction({ amount: -50, status: "PENDING" }),
      "bank",
      context,
    );
    expect(pending).toMatchObject({ status: "pending" });
  });

  it("books a pending card charge as a fact, because the purchase already happened", () => {
    const openInvoiceCharge = normalizeTransaction(
      transaction({ amount: 50, status: "PENDING" }),
      "credit",
      context,
    );
    expect(openInvoiceCharge).toMatchObject({ status: "imported" });
  });

  it("treats POSTED as a fact on both kinds", () => {
    expect(normalizeTransaction(transaction(), "bank", context)).toMatchObject({
      status: "imported",
    });
    expect(normalizeTransaction(transaction(), "credit", context)).toMatchObject({
      status: "imported",
    });
  });

  it("extracts an installment plan only when there is more than one instalment", () => {
    const parcelled = normalizeTransaction(
      transaction({
        amount: 150,
        creditCardMetadata: { installmentNumber: 3, totalInstallments: 6, totalAmount: 900 },
      }),
      "credit",
      context,
    );
    expect(parcelled).toMatchObject({
      installment: { number: 3, total: 6, totalAmountMinor: 90000 },
    });

    const single = normalizeTransaction(
      transaction({ creditCardMetadata: { installmentNumber: 1, totalInstallments: 1 } }),
      "credit",
      context,
    );
    expect(single).toMatchObject({ installment: null });
  });

  it("carries the bill link through", () => {
    const charge = normalizeTransaction(
      transaction({ creditCardMetadata: { billId: "bill-9" } }),
      "credit",
      context,
    );
    expect(charge).toMatchObject({ billExternalId: "bill-9" });
  });

  it("flags a bank outflow that looks like a card bill payment without acting on it", () => {
    const result = normalizeTransaction(
      transaction({ amount: -1234.5, description: "PAGAMENTO DE FATURA CARTAO" }),
      "bank",
      context,
    );
    expect(result).toMatchObject({ type: "expense", cardPaymentCandidate: true });
  });

  it("does not flag an inflow or an unrelated expense", () => {
    expect(
      normalizeTransaction(transaction({ amount: 10, description: "Pagamento fatura" }), "bank", context),
    ).toMatchObject({ cardPaymentCandidate: false });
    expect(
      normalizeTransaction(transaction({ amount: -10, description: "Padaria" }), "bank", context),
    ).toMatchObject({ cardPaymentCandidate: false });
  });

  it("falls back to a description rather than writing an empty one", () => {
    const result = normalizeTransaction(
      transaction({ description: "   ", descriptionRaw: "TED 123" }),
      "bank",
      context,
    );
    expect(result).toMatchObject({ description: "TED 123", rawDescription: "TED 123" });
  });

  it("reads a merchant name out of the merchant object", () => {
    const result = normalizeTransaction(
      transaction({ merchantName: "Zé Pães" }),
      "bank",
      context,
    );
    expect(result).toMatchObject({ merchant: "Zé Pães" });
  });
});

describe("looksLikeCardBillPayment", () => {
  it("matches common Brazilian wordings regardless of accents or case", () => {
    expect(looksLikeCardBillPayment("PAGAMENTO DE FATURA")).toBe(true);
    expect(looksLikeCardBillPayment("Pagto Cartão Nubank")).toBe(true);
    expect(looksLikeCardBillPayment("Credit card payment")).toBe(true);
  });

  it("does not match an ordinary purchase", () => {
    expect(looksLikeCardBillPayment("Supermercado Pague Menos")).toBe(false);
  });
});

describe("normalizeBill", () => {
  const bill: PluggyBill = {
    id: "bill-1",
    dueDate: "2023-09-15T00:00:00.000Z",
    billClosingDate: "2023-09-08T00:00:00.000Z",
    totalAmount: 10000.76,
    totalAmountCurrencyCode: "BRL",
    minimumPaymentAmount: 3000,
    payments: [
      { paymentDate: "2023-09-14T00:00:00.000Z", amount: 5000 },
      { paymentDate: "2023-09-15T00:00:00.000Z", amount: 5000.76 },
    ],
  } as PluggyBill;

  it("reports the bill's own dates and total, leaving the cycle key to the adapter", () => {
    expect(normalizeBill(bill, context)).not.toHaveProperty("statementMonth");
    expect(normalizeBill(bill, context)).toMatchObject({
      dueAt: "2023-09-15",
      closedAt: "2023-09-08",
      totalMinor: 1000076,
      minimumPaymentMinor: 300000,
      isPaid: true,
      paidAt: "2023-09-15",
    });
  });

  it("reports an unpaid bill as unpaid", () => {
    const open = normalizeBill({ ...bill, payments: [] } as PluggyBill, context);
    expect(open).toMatchObject({ isPaid: false, paidAt: null });
  });
});

describe("statusFor", () => {
  it("splits PENDING by account kind", () => {
    expect(statusFor("PENDING", "bank")).toBe("pending");
    expect(statusFor("PENDING", "credit")).toBe("imported");
  });

  it("treats anything else, including a missing status, as a fact", () => {
    expect(statusFor("POSTED", "bank")).toBe("imported");
    expect(statusFor(null, "bank")).toBe("imported");
    expect(statusFor(undefined, "credit")).toBe("imported");
  });
});
