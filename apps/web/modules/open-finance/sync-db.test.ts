import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  db,
  installmentPlans,
  installments,
  openFinanceAccountLinks,
  openFinanceConnections,
  transactionMetadata,
  transactions,
  users,
} from "@kosh/db";
import type {
  PluggyAccount,
  PluggyBill,
  PluggyClient,
  PluggyItem,
  PluggyTransaction,
} from "@hermes-finance/open-finance";
import { syncConnection } from "./sync";

/**
 * The sync against a real database, with the provider stubbed.
 *
 * The provider is the only thing faked: the ledger writes, the unique indexes,
 * the balance recomputation and the encrypted columns are all real, because
 * those are exactly where this feature can be wrong in ways a pure test cannot
 * see.
 */
const stamp = randomUUID().slice(0, 8);
const userId = `open_finance_probe_${stamp}`;
const ITEM_ID = randomUUID();

function stubClient(overrides: {
  item?: Partial<PluggyItem>;
  accounts?: PluggyAccount[];
  transactions?: Record<string, PluggyTransaction[]>;
  bills?: Record<string, PluggyBill[]>;
} = {}): PluggyClient {
  return {
    async getItem() {
      return {
        id: ITEM_ID,
        connector: { id: 201, name: "Banco Teste", imageUrl: null, primaryColor: null },
        status: "UPDATED",
        executionStatus: "SUCCESS",
        lastUpdatedAt: "2026-03-10T09:00:00.000Z",
        consentExpiresAt: null,
        errorCode: null,
        ...overrides.item,
      } as PluggyItem;
    },
    async listAccounts() {
      return overrides.accounts ?? [];
    },
    async listTransactions(accountId) {
      return overrides.transactions?.[accountId] ?? [];
    },
    async listBills(accountId) {
      return overrides.bills?.[accountId] ?? [];
    },
  };
}

function bankAccount(overrides: Partial<PluggyAccount> = {}): PluggyAccount {
  return {
    id: "prov-bank",
    itemId: ITEM_ID,
    type: "BANK",
    subtype: "CHECKING_ACCOUNT",
    number: "0001/12345-7788",
    name: "Conta Corrente",
    marketingName: null,
    balance: 1500.5,
    currencyCode: "BRL",
    creditData: null,
    ...overrides,
  };
}

function cardAccount(overrides: Partial<PluggyAccount> = {}): PluggyAccount {
  return {
    id: "prov-card",
    itemId: ITEM_ID,
    type: "CREDIT",
    subtype: "CREDIT_CARD",
    number: "4321",
    name: "Cartão Teste",
    marketingName: null,
    balance: 250,
    currencyCode: "BRL",
    creditData: {
      brand: "VISA",
      balanceCloseDate: "2026-03-08",
      balanceDueDate: "2026-03-17",
      creditLimit: 5000,
      availableCreditLimit: 4750,
      minimumPayment: 50,
    },
    ...overrides,
  };
}

function tx(overrides: Partial<PluggyTransaction> = {}): PluggyTransaction {
  return {
    id: `prov-tx-${randomUUID().slice(0, 8)}`,
    accountId: "prov-bank",
    description: "Padaria",
    descriptionRaw: null,
    currencyCode: "BRL",
    amount: -25.5,
    date: "2026-03-05T00:00:00.000Z",
    category: "Food",
    type: "DEBIT",
    status: "POSTED",
    merchantName: null,
    paymentReason: null,
    creditCardMetadata: null,
    ...overrides,
  };
}

const NOW = () => new Date("2026-03-10T12:00:00.000Z");

async function freshConnection(): Promise<string> {
  await db.delete(openFinanceConnections).where(eq(openFinanceConnections.userId, userId));
  const ids = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  if (ids.length > 0) {
    await db.delete(transactions).where(eq(transactions.userId, userId));
    await db.delete(balanceSnapshots).where(eq(balanceSnapshots.userId, userId));
    await db.delete(accounts).where(
      inArray(accounts.id, ids.map((row) => row.id)),
    );
  }
  const [connection] = await db
    .insert(openFinanceConnections)
    .values({ userId, itemId: ITEM_ID, connectorName: "Banco Teste" })
    .returning({ id: openFinanceConnections.id });
  return connection!.id;
}

beforeEach(async () => {
  await db
    .insert(users)
    .values({ id: userId, name: "Open Finance probe", email: `${userId}@kosh.test` })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

async function accountFor(providerAccountId: string) {
  const link = await db.query.openFinanceAccountLinks.findFirst({
    where: and(
      eq(openFinanceAccountLinks.userId, userId),
      eq(openFinanceAccountLinks.providerAccountId, providerAccountId),
    ),
  });
  if (!link?.accountId) return null;
  return db.query.accounts.findFirst({ where: eq(accounts.id, link.accountId) });
}

describe("first sync of a bank account", () => {
  it("creates the account and lands the ledger exactly on the bank's balance", async () => {
    const connectionId = await freshConnection();
    const client = stubClient({
      accounts: [bankAccount()],
      transactions: {
        "prov-bank": [
          tx({ id: "a", amount: -25.5 }),
          tx({ id: "b", amount: 3000, type: "CREDIT", description: "Salário" }),
        ],
      },
    });

    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client,
      now: NOW,
    });

    expect(summary.status).toBe("ok");
    expect(summary.counts.created).toBe(2);

    const account = await accountFor("prov-bank");
    expect(account?.type).toBe("asset");
    expect(account?.currencyCode).toBe("BRL");
    // The point of the opening-balance derivation: twelve months of history
    // cannot add up to a balance that took years to build, so the difference
    // goes into the opening balance rather than into an invented transaction.
    expect(account?.currentBalanceMinor).toBe(150050);
    expect(account?.openingBalanceMinor).toBe(150050 - (-2550 + 300000));
  });

  it("records the provider's own observation date, not ours", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({ accounts: [bankAccount()] }),
      now: NOW,
    });

    const [snapshot] = await db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.userId, userId));
    expect(snapshot?.source).toBe("pluggy");
    expect(snapshot?.observedAt).toBe("2026-03-10");
    expect(snapshot?.amountMinor).toBe(150050);
  });
});

describe("running the same batch twice", () => {
  it("creates nothing the second time and leaves the balance untouched", async () => {
    const connectionId = await freshConnection();
    const payload = {
      accounts: [bankAccount()],
      transactions: { "prov-bank": [tx({ id: "a" }), tx({ id: "b", amount: 100 })] },
    };

    const first = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient(payload),
      now: NOW,
    });
    const balanceAfterFirst = (await accountFor("prov-bank"))?.currentBalanceMinor;

    const second = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient(payload),
      now: NOW,
    });

    expect(first.counts.created).toBe(2);
    expect(second.counts.created).toBe(0);
    expect(second.counts.updated).toBe(2);
    expect((await accountFor("prov-bank"))?.currentBalanceMinor).toBe(balanceAfterFirst);

    const rows = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    expect(rows).toHaveLength(2);
  });
});

describe("credit cards", () => {
  it("skips the bill payment leg instead of booking a second expense", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [cardAccount()],
        transactions: {
          "prov-card": [
            // Positive on a card is a purchase.
            tx({ id: "c1", accountId: "prov-card", amount: 80, description: "Mercado" }),
            // Negative is the cardholder settling the bill (PRD R4).
            tx({ id: "c2", accountId: "prov-card", amount: -500, description: "Pagamento" }),
          ],
        },
      }),
      now: NOW,
    });

    expect(summary.counts.created).toBe(1);
    expect(summary.counts.skipped).toBe(1);

    const rows = await db
      .select({ type: transactions.type, amountMinor: transactions.amountMinor })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    expect(rows).toEqual([{ type: "expense", amountMinor: -8000 }]);

    const account = await accountFor("prov-card");
    expect(account?.type).toBe("credit_card");
    // A card's open bill is a debt, so the balance is negative in Hermes even
    // though Pluggy reports it as a positive amount owed.
    expect(account?.currentBalanceMinor).toBe(-25000);
  });
});

describe("the card bill payment on the bank side", () => {
  it("is booked, but tagged so a later phase can pair it into a transfer", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount()],
        transactions: {
          "prov-bank": [
            tx({ id: "p1", amount: -500, description: "PAGAMENTO DE FATURA CARTAO" }),
          ],
        },
      }),
      now: NOW,
    });

    const [row] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userId));
    const tags = await db
      .select({ key: transactionMetadata.key, value: transactionMetadata.value })
      .from(transactionMetadata)
      .where(eq(transactionMetadata.transactionId, row!.id));

    expect(tags).toContainEqual({ key: "open_finance.card_payment_candidate", value: "true" });
    expect(tags).toContainEqual({ key: "open_finance.provider", value: "pluggy" });
  });
});

describe("linking to an account the user already has", () => {
  it("reuses it rather than creating a second one", async () => {
    const connectionId = await freshConnection();
    const [own] = await db
      .insert(accounts)
      .values({
        userId,
        name: "Banco Teste Principal",
        type: "asset",
        currencyCode: "BRL",
        institution: "Banco Teste",
        accountNumberMask: "7788",
        openingBalanceMinor: 0,
      })
      .returning({ id: accounts.id });

    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({ accounts: [bankAccount()], transactions: { "prov-bank": [tx()] } }),
      now: NOW,
    });

    expect(summary.status).toBe("ok");
    const link = await db.query.openFinanceAccountLinks.findFirst({
      where: eq(openFinanceAccountLinks.userId, userId),
    });
    expect(link?.accountId).toBe(own!.id);
    expect(link?.linkMode).toBe("matched_existing");

    const all = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
    expect(all).toHaveLength(1);

    // An account the user owns keeps its own opening balance: the sync must not
    // rewrite a history it did not create.
    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, own!.id) });
    expect(account?.openingBalanceMinor).toBe(0);
  });
});

describe("an item the user has to fix", () => {
  it("writes nothing to the ledger and says what to do", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        item: { status: "LOGIN_ERROR" },
        accounts: [bankAccount()],
        transactions: { "prov-bank": [tx()] },
      }),
      now: NOW,
    });

    expect(summary.status).toBe("error");
    expect(summary.message).toContain("meu.pluggy.ai");

    const rows = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.userId, userId));
    expect(rows).toHaveLength(0);
  });
});

describe("unsupported account types", () => {
  it("are recorded and skipped rather than forced into the nearest model", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount({ id: "prov-inv", type: "INVESTMENT", subtype: null })],
      }),
      now: NOW,
    });

    expect(summary.counts.skipped).toBe(1);
    const link = await db.query.openFinanceAccountLinks.findFirst({
      where: and(
        eq(openFinanceAccountLinks.userId, userId),
        eq(openFinanceAccountLinks.providerAccountId, "prov-inv"),
      ),
    });
    expect(link?.linkMode).toBe("unsupported");
    expect(link?.accountId).toBeNull();
  });
});

describe("tenancy", () => {
  it("refuses to sync another user's connection", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection("someone-else", connectionId, {
      trigger: "manual",
      client: stubClient({ accounts: [bankAccount()] }),
      now: NOW,
    });
    expect(summary.status).toBe("error");
    expect(summary.message).toBe("Connection not found.");
  });
});

describe("credit card bills", () => {
  const bill = (overrides: Partial<PluggyBill> = {}): PluggyBill => ({
    id: "prov-bill-1",
    dueDate: "2026-03-17T00:00:00.000Z",
    billClosingDate: "2026-03-08T00:00:00.000Z",
    totalAmount: 250,
    totalAmountCurrencyCode: "BRL",
    minimumPaymentAmount: 50,
    payments: [],
    ...overrides,
  });

  it("writes a confirmed cycle, which is what raises the statement to CONFIRMED", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [cardAccount()],
        transactions: {
          "prov-card": [
            tx({
              id: "c1",
              accountId: "prov-card",
              amount: 250,
              date: "2026-03-02T00:00:00.000Z",
              creditCardMetadata: {
                installmentNumber: null,
                totalInstallments: null,
                totalAmount: null,
                cardNumber: null,
                billId: "prov-bill-1",
              },
            }),
          ],
        },
        bills: { "prov-card": [bill()] },
      }),
      now: NOW,
    });

    const account = await accountFor("prov-card");
    const card = await db.query.creditCards.findFirst({
      where: eq(creditCards.accountId, account!.id),
    });
    expect(card?.defaultClosingDay).toBe(8);
    expect(card?.defaultDueDay).toBe(17);
    expect(card?.creditLimitMinor).toBe(500000);

    const cycles = await db
      .select()
      .from(creditCardBillingCycles)
      .where(eq(creditCardBillingCycles.creditCardId, card!.id));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      source: "pluggy",
      confirmedTotalMinor: 25000,
      dueAt: "2026-03-17",
      closedAt: "2026-03-08",
      // The charges Pluggy attributed to this bill add up to its total, so the
      // cycle reconciles and stays out of the review queue (PRD §29).
      status: "closed",
    });
  });

  it("flags a cycle whose charges do not add up to the published total", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [cardAccount()],
        transactions: {
          "prov-card": [
            tx({
              id: "c1",
              accountId: "prov-card",
              amount: 200,
              date: "2026-03-02T00:00:00.000Z",
              creditCardMetadata: {
                installmentNumber: null,
                totalInstallments: null,
                totalAmount: null,
                cardNumber: null,
                billId: "prov-bill-1",
              },
            }),
          ],
        },
        // 250 published against 200 charged: a fee, interest, or a missing
        // purchase. The system must not decide which.
        bills: { "prov-card": [bill({ totalAmount: 250 })] },
      }),
      now: NOW,
    });

    const account = await accountFor("prov-card");
    const card = await db.query.creditCards.findFirst({
      where: eq(creditCards.accountId, account!.id),
    });
    const cycles = await db
      .select()
      .from(creditCardBillingCycles)
      .where(eq(creditCardBillingCycles.creditCardId, card!.id));
    expect(cycles[0]?.status).toBe("needs_review");
  });

  it("builds one plan from an installment, not one purchase per parcel", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [cardAccount()],
        transactions: {
          "prov-card": [
            tx({
              id: "c1",
              accountId: "prov-card",
              amount: 100,
              date: "2026-03-02T00:00:00.000Z",
              description: "Geladeira",
              creditCardMetadata: {
                installmentNumber: 3,
                totalInstallments: 6,
                totalAmount: 600,
                cardNumber: null,
                billId: null,
              },
            }),
          ],
        },
        bills: { "prov-card": [bill()] },
      }),
      now: NOW,
    });

    const account = await accountFor("prov-card");
    const card = await db.query.creditCards.findFirst({
      where: eq(creditCards.accountId, account!.id),
    });
    const purchases = await db
      .select()
      .from(creditCardPurchases)
      .where(eq(creditCardPurchases.creditCardId, card!.id));
    expect(purchases).toHaveLength(1);
    expect(purchases[0]?.totalAmountMinor).toBe(60000);

    const plans = await db
      .select()
      .from(installmentPlans)
      .where(eq(installmentPlans.creditCardPurchaseId, purchases[0]!.id));
    expect(plans[0]).toMatchObject({ totalInstallments: 6, firstInstallmentNumber: 3 });

    const parcels = await db
      .select()
      .from(installments)
      .where(eq(installments.installmentPlanId, plans[0]!.id));
    // Parcel 3 is a fact; 4 through 6 are projections. Parcels 1 and 2 are not
    // invented: they were billed before the provider's window and are gone.
    expect(parcels.map((p) => p.number).sort()).toEqual([3, 4, 5, 6]);
    expect(parcels.find((p) => p.number === 3)?.status).toBe("billed");
    expect(parcels.filter((p) => p.number > 3).every((p) => p.status === "projected")).toBe(true);
  });
});
