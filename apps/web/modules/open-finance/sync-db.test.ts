import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  categories,
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  db,
  installmentPlans,
  installments,
  openFinanceAccountLinks,
  openFinanceCardPayments,
  openFinanceConnections,
  openFinanceSyncRuns,
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

describe("paying a card bill", () => {
  /**
   * The whole point of R4 and R5 in one test: the bank outflow that settles a
   * statement is one transfer, not an expense plus a mystery, and the card's
   * balance comes back up by exactly what was paid.
   */
  it("becomes a transfer that credits the card", async () => {
    const connectionId = await freshConnection();

    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount(), cardAccount()],
        transactions: {
          "prov-bank": [
            tx({ id: "b1", amount: -500, description: "PAGAMENTO DE FATURA CARTAO",
                 date: "2026-03-07T00:00:00.000Z" }),
          ],
          "prov-card": [
            tx({ id: "c1", accountId: "prov-card", amount: 120, description: "Mercado",
                 date: "2026-03-02T00:00:00.000Z" }),
            // The card side of the same payment: skipped, but remembered.
            tx({ id: "c2", accountId: "prov-card", amount: -500, description: "Pagamento recebido",
                 date: "2026-03-07T00:00:00.000Z" }),
          ],
        },
      }),
      now: NOW,
    });

    const bankAccountRow = await accountFor("prov-bank");
    const cardAccountRow = await accountFor("prov-card");

    const [payment] = await db
      .select({
        type: transactions.type,
        amountMinor: transactions.amountMinor,
        transferAccountId: transactions.transferAccountId,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "b1")));

    expect(payment).toMatchObject({
      type: "transfer",
      amountMinor: -50000,
      transferAccountId: cardAccountRow!.id,
      // Never categorized: a transfer between your own accounts is neither
      // income nor expense, so any category a rule guessed is wrong (R5).
      categoryId: null,
    });

    // The card was fed one purchase of 120 and credited 500 by the transfer.
    // Without the pairing it would sit at -12000 and drift further every month.
    const card = await db.query.accounts.findFirst({ where: eq(accounts.id, cardAccountRow!.id) });
    const bank = await db.query.accounts.findFirst({ where: eq(accounts.id, bankAccountRow!.id) });
    expect(card!.currentBalanceMinor - card!.openingBalanceMinor).toBe(-12000 + 50000);
    // The paying account is unaffected by the reclassification: the same money
    // still left it.
    expect(bank!.currentBalanceMinor - bank!.openingBalanceMinor).toBe(-50000);

    // The card side is never booked as a transaction of its own (R4).
    const cardRows = await db
      .select({ externalId: transactions.externalId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.accountId, cardAccountRow!.id)));
    expect(cardRows.map((r) => r.externalId)).toEqual(["c1"]);
  });

  it("leaves the outflow alone when no card payment explains it", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount(), cardAccount()],
        transactions: {
          "prov-bank": [
            tx({ id: "b1", amount: -500, description: "PAGAMENTO DE FATURA CARTAO" }),
          ],
          // No matching leg on the card: the bill was paid from somewhere else.
          "prov-card": [],
        },
      }),
      now: NOW,
    });

    const [payment] = await db
      .select({ type: transactions.type, transferAccountId: transactions.transferAccountId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "b1")));
    expect(payment).toMatchObject({ type: "expense", transferAccountId: null });
  });

  it("does not let one outflow settle two cards", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [
          bankAccount(),
          cardAccount(),
          cardAccount({ id: "prov-card-2", number: "9999", name: "Cartão Dois" }),
        ],
        transactions: {
          "prov-bank": [
            tx({ id: "b1", amount: -500, description: "PAGAMENTO DE FATURA CARTAO",
                 date: "2026-03-07T00:00:00.000Z" }),
          ],
          // Both cards report a payment of the same value on the same day.
          "prov-card": [
            tx({ id: "c2", accountId: "prov-card", amount: -500, date: "2026-03-07T00:00:00.000Z" }),
          ],
          "prov-card-2": [
            tx({ id: "d2", accountId: "prov-card-2", amount: -500, date: "2026-03-07T00:00:00.000Z" }),
          ],
        },
      }),
      now: NOW,
    });

    const [payment] = await db
      .select({ type: transactions.type })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "b1")));
    // PRD §14: two plausible answers means no answer, not a coin toss.
    expect(payment).toMatchObject({ type: "expense" });
  });

  it("is idempotent — a second sync does not pair it twice", async () => {
    const connectionId = await freshConnection();
    const payload = {
      accounts: [bankAccount(), cardAccount()],
      transactions: {
        "prov-bank": [
          tx({ id: "b1", amount: -500, description: "PAGAMENTO DE FATURA CARTAO",
               date: "2026-03-07T00:00:00.000Z" }),
        ],
        "prov-card": [
          tx({ id: "c2", accountId: "prov-card", amount: -500, date: "2026-03-07T00:00:00.000Z" }),
        ],
      },
    };

    await syncConnection(userId, connectionId, { trigger: "manual", client: stubClient(payload), now: NOW });
    const card = await accountFor("prov-card");
    const afterFirst = (await db.query.accounts.findFirst({ where: eq(accounts.id, card!.id) }))!
      .currentBalanceMinor;

    await syncConnection(userId, connectionId, { trigger: "manual", client: stubClient(payload), now: NOW });
    const afterSecond = (await db.query.accounts.findFirst({ where: eq(accounts.id, card!.id) }))!
      .currentBalanceMinor;

    expect(afterSecond).toBe(afterFirst);
  });
});

describe("the opening balance of an auto-created account", () => {
  /**
   * The regression that reached production: the opening balance was solved once,
   * while the card still had no payments in it. When the payments later became
   * transfers the card counted them twice and its balance went positive, so the
   * cards screen reported a fully available limit on a card that owed R$10k.
   */
  it("is re-solved when pairing changes what the ledger contains", async () => {
    const connectionId = await freshConnection();
    const payload = {
      accounts: [bankAccount(), cardAccount()],
      transactions: {
        "prov-bank": [
          tx({ id: "b1", amount: -500, description: "PAGAMENTO DE FATURA CARTAO",
               date: "2026-03-07T00:00:00.000Z" }),
        ],
        "prov-card": [
          tx({ id: "c1", accountId: "prov-card", amount: 120, date: "2026-03-02T00:00:00.000Z" }),
          tx({ id: "c2", accountId: "prov-card", amount: -500, date: "2026-03-07T00:00:00.000Z" }),
        ],
      },
    };

    await syncConnection(userId, connectionId, { trigger: "manual", client: stubClient(payload), now: NOW });

    const card = await accountFor("prov-card");
    const bank = await accountFor("prov-bank");
    // Pluggy reports the card's open bill as 250, which is a debt of -250.
    expect(card!.currentBalanceMinor).toBe(-25000);
    expect(bank!.currentBalanceMinor).toBe(150050);
  });

  it("converges on the provider's number across repeated syncs", async () => {
    const connectionId = await freshConnection();
    const first = {
      accounts: [cardAccount({ balance: 250 })],
      transactions: {
        "prov-card": [tx({ id: "c1", accountId: "prov-card", amount: 120, date: "2026-03-02T00:00:00.000Z" })],
      },
    };
    await syncConnection(userId, connectionId, { trigger: "manual", client: stubClient(first), now: NOW });
    expect((await accountFor("prov-card"))!.currentBalanceMinor).toBe(-25000);

    // A later run sees a new charge and a balance that moved with it. Nothing
    // about the account is re-created, so only the correction keeps it honest.
    const second = {
      accounts: [cardAccount({ balance: 400 })],
      transactions: {
        "prov-card": [
          tx({ id: "c1", accountId: "prov-card", amount: 120, date: "2026-03-02T00:00:00.000Z" }),
          tx({ id: "c3", accountId: "prov-card", amount: 150, date: "2026-03-09T00:00:00.000Z" }),
        ],
      },
    };
    await syncConnection(userId, connectionId, { trigger: "manual", client: stubClient(second), now: NOW });
    expect((await accountFor("prov-card"))!.currentBalanceMinor).toBe(-40000);
  });

  it("never rewrites the opening balance of an account the user already owned", async () => {
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
        openingBalanceMinor: 100000,
      })
      .returning({ id: accounts.id });

    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({ accounts: [bankAccount()], transactions: { "prov-bank": [tx()] } }),
      now: NOW,
    });

    const account = await db.query.accounts.findFirst({ where: eq(accounts.id, own!.id) });
    expect(account!.openingBalanceMinor).toBe(100000);
  });
});

describe("the category the provider suggests", () => {
  async function categoryOf(externalId: string) {
    const [row] = await db
      .select({ name: categories.name })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, externalId)));
    return row?.name ?? null;
  }

  it("is applied when the user has a category by that name", async () => {
    const connectionId = await freshConnection();
    await db.insert(categories).values({ userId, name: "Supermercado" }).onConflictDoNothing();

    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount()],
        transactions: { "prov-bank": [tx({ id: "a", category: "Groceries" })] },
      }),
      now: NOW,
    });

    expect(await categoryOf("a")).toBe("Supermercado");
  });

  it("labels a movement between own accounts instead of leaving it blank", async () => {
    const connectionId = await freshConnection();
    await db.insert(categories).values({ userId, name: "Transferências" }).onConflictDoNothing();

    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount()],
        transactions: {
          "prov-bank": [tx({ id: "a", amount: -100, category: "Same person transfer" })],
        },
      }),
      now: NOW,
    });

    // Still not spending (R5) — but named, so it stops being the anonymous
    // block that dominated the breakdown.
    expect(await categoryOf("a")).toBe("Transferências");
  });

  it("gives a paired card payment the same label rather than none", async () => {
    const connectionId = await freshConnection();
    await db.insert(categories).values({ userId, name: "Transferências" }).onConflictDoNothing();

    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount(), cardAccount()],
        transactions: {
          "prov-bank": [tx({ id: "a", amount: -500, description: "PAGAMENTO DE FATURA CARTAO",
            date: "2026-03-07T00:00:00.000Z" })],
          "prov-card": [tx({ id: "c2", accountId: "prov-card", amount: -500,
            date: "2026-03-07T00:00:00.000Z" })],
        },
      }),
      now: NOW,
    });

    const [row] = await db
      .select({ type: transactions.type })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "a")));
    expect(row!.type).toBe("transfer");
    expect(await categoryOf("a")).toBe("Transferências");
  });

  it("reports a provider category it has no name for instead of guessing", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount()],
        transactions: { "prov-bank": [tx({ id: "a", category: "Brand New Pluggy Category" })] },
      }),
      now: NOW,
    });

    expect(await categoryOf("a")).toBeNull();
    const [run] = await db
      .select({ stats: openFinanceSyncRuns.stats })
      .from(openFinanceSyncRuns)
      .where(eq(openFinanceSyncRuns.id, summary.runId!));
    expect(run!.stats.unmappedCategories).toContain("Brand New Pluggy Category");
  });

  it("does not undo a category set after the import when the window is re-read", async () => {
    const connectionId = await freshConnection();
    await db.insert(categories).values({ userId, name: "Supermercado" }).onConflictDoNothing();
    const [other] = await db
      .insert(categories).values({ userId, name: "Categoria escolhida" })
      .onConflictDoNothing().returning({ id: categories.id });

    const payload = {
      accounts: [bankAccount()],
      transactions: { "prov-bank": [tx({ id: "a", category: "Groceries" })] },
    };
    await syncConnection(userId, connectionId, { trigger: "manual", client: stubClient(payload), now: NOW });

    // Stand in for a rule, or for the user picking a category by hand.
    await db.update(transactions).set({ categoryId: other!.id })
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "a")));

    await syncConnection(userId, connectionId, { trigger: "manual", client: stubClient(payload), now: NOW });
    expect(await categoryOf("a")).toBe("Categoria escolhida");
  });
});

describe("parcels of one purchase", () => {
  /**
   * The provider sends one transaction per parcel and rounds the purchase total
   * differently on each. Matching on that total made every parcel its own plan,
   * so a twelve-month purchase projected its tail twelve times (PRD R3).
   */
  it("join one plan even when the provider's total drifts by a cent", async () => {
    const connectionId = await freshConnection();
    const parcel = (id: string, n: number, total: number, date: string) =>
      tx({
        id,
        accountId: "prov-card",
        amount: 20.07,
        date,
        description: "Geladeira",
        creditCardMetadata: {
          installmentNumber: n,
          totalInstallments: 12,
          // 240.87 on one parcel, 240.83 on the next — the same purchase.
          totalAmount: total,
          cardNumber: null,
          billId: null,
        },
      });

    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [cardAccount()],
        transactions: {
          "prov-card": [
            parcel("p1", 1, 240.87, "2026-01-05T00:00:00.000Z"),
            parcel("p2", 2, 240.83, "2026-02-05T00:00:00.000Z"),
            parcel("p3", 3, 240.85, "2026-03-05T00:00:00.000Z"),
          ],
        },
      }),
      now: NOW,
    });

    const account = await accountFor("prov-card");
    const card = await db.query.creditCards.findFirst({
      where: eq(creditCards.accountId, account!.id),
    });
    const purchases = await db
      .select({ id: creditCardPurchases.id })
      .from(creditCardPurchases)
      .where(eq(creditCardPurchases.creditCardId, card!.id));
    expect(purchases).toHaveLength(1);

    const plans = await db
      .select({ id: installmentPlans.id })
      .from(installmentPlans)
      .where(eq(installmentPlans.creditCardPurchaseId, purchases[0]!.id));
    expect(plans).toHaveLength(1);

    const parcels = await db
      .select({ number: installments.number, status: installments.status })
      .from(installments)
      .where(eq(installments.installmentPlanId, plans[0]!.id));
    // Twelve parcels, not thirty-six: 1 to 3 settled, the rest still ahead.
    expect(parcels).toHaveLength(12);
    const billed = parcels.filter((p) => p.status === "billed").map((p) => p.number).sort();
    expect(billed).toEqual([1, 2, 3]);
  });
});

describe("a movement between two of the user's own accounts", () => {
  async function statsOf(runId: string) {
    const [run] = await db
      .select({ stats: openFinanceSyncRuns.stats })
      .from(openFinanceSyncRuns)
      .where(eq(openFinanceSyncRuns.id, runId));
    return run!.stats;
  }

  const twoBanks = () => [
    bankAccount({ id: "prov-bank", number: "0001/12345-7788", balance: 1500.5 }),
    bankAccount({
      id: "prov-bank-2",
      number: "0002/98765-4321",
      name: "Conta Poupança",
      balance: 800,
    }),
  ];

  /** The same R$ 2.194,06 seen from both sides, plus real income for contrast. */
  const bothLegs = () => ({
    "prov-bank": [
      tx({ id: "out", amount: -2194.06, description: "Pix enviado - Fulano", category: "Transfer - PIX" }),
    ],
    "prov-bank-2": [
      tx({
        id: "in",
        accountId: "prov-bank-2",
        amount: 2194.06,
        type: "CREDIT",
        description: "PIX RECEBIDO   FULANO",
        category: "Same person transfer",
      }),
      tx({
        id: "salary",
        accountId: "prov-bank-2",
        amount: 6080,
        type: "CREDIT",
        description: "Pix recebido - Fulano Tecnologia Ltda",
        category: "Transfer - PIX",
      }),
    ],
  });

  it("keeps one negative transfer pointing at the destination and retires the credit", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({ accounts: twoBanks(), transactions: bothLegs() }),
      now: NOW,
    });

    expect(summary.status).toBe("ok");
    expect((await statsOf(summary.runId!)).selfTransfersPaired).toBe(1);

    const source = await accountFor("prov-bank");
    const destination = await accountFor("prov-bank-2");

    const outflow = await db.query.transactions.findFirst({
      where: and(eq(transactions.userId, userId), eq(transactions.externalId, "out")),
    });
    // The schema allows no other shape: a transfer row must be negative and must
    // name where the money went.
    expect(outflow?.type).toBe("transfer");
    expect(outflow?.amountMinor).toBe(-219406);
    expect(outflow?.transferAccountId).toBe(destination!.id);
    expect(outflow?.deletedAt).toBeNull();

    const inflow = await db.query.transactions.findFirst({
      where: and(eq(transactions.userId, userId), eq(transactions.externalId, "in")),
    });
    // Kept out of the ledger rather than rewritten: the destination leg is
    // derived from the row above, so leaving this one live would credit the
    // destination twice.
    expect(inflow?.deletedAt).not.toBeNull();
    expect(source).toBeTruthy();
  });

  it("stops the money being counted as income, and leaves real income alone", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({ accounts: twoBanks(), transactions: bothLegs() }),
      now: NOW,
    });

    const income = await db.query.transactions.findMany({
      where: and(
        eq(transactions.userId, userId),
        eq(transactions.type, "income"),
        isNull(transactions.deletedAt),
      ),
    });
    // R$ 6.080 is money from someone else with no matching debit anywhere; the
    // R$ 2.194,06 was never income at all (PRD R5).
    expect(income.map((row) => row.amountMinor)).toEqual([608000]);
  });

  it("does not resurrect the retired credit on the next sync", async () => {
    const connectionId = await freshConnection();
    const client = stubClient({ accounts: twoBanks(), transactions: bothLegs() });
    await syncConnection(userId, connectionId, { trigger: "manual", client, now: NOW });
    await syncConnection(userId, connectionId, { trigger: "manual", client, now: NOW });

    // The unique index behind the upsert ignores soft-deleted rows, so without
    // the suppression check the provider would re-insert this every run and the
    // double count would come back on its own.
    const live = await db.query.transactions.findMany({
      where: and(
        eq(transactions.userId, userId),
        eq(transactions.externalId, "in"),
        isNull(transactions.deletedAt),
      ),
    });
    expect(live).toHaveLength(0);
  });

  it("leaves a credit alone while the matching debit has not arrived", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: twoBanks(),
        transactions: { "prov-bank-2": bothLegs()["prov-bank-2"] },
      }),
      now: NOW,
    });

    expect((await statsOf(summary.runId!)).selfTransfersPaired).toBeUndefined();
    const inflow = await db.query.transactions.findFirst({
      where: and(eq(transactions.userId, userId), eq(transactions.externalId, "in")),
    });
    expect(inflow?.type).toBe("income");
    expect(inflow?.deletedAt).toBeNull();
  });
});

describe("a bill paid by Pix or boleto", () => {
  /** What the bank really shows: the issuer's name, never the word fatura. */
  const paidByPix = () => ({
    "prov-bank": [
      tx({
        id: "b-pix",
        amount: -366.83,
        description: "PIX ENVIADO   Nu Pagamentos S A",
        category: "Credit card payment",
        date: "2026-03-07T00:00:00.000Z",
      }),
    ],
    "prov-card": [
      tx({
        id: "c-pix",
        accountId: "prov-card",
        amount: -366.83,
        description: "Pagamento recebido",
        category: "Credit card payment",
        date: "2026-03-07T00:00:00.000Z",
      }),
    ],
  });

  it("is a transfer, not a second expense (PRD R4)", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount(), cardAccount()],
        transactions: paidByPix(),
      }),
      now: NOW,
    });

    const card = await accountFor("prov-card");
    const [payment] = await db
      .select({ type: transactions.type, transferAccountId: transactions.transferAccountId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "b-pix")));

    // The phrase list cannot see this one; the provider's category can.
    expect(payment).toMatchObject({ type: "transfer", transferAccountId: card!.id });
  });

  it("marks the leg the payment actually settled, not a different open one", async () => {
    const connectionId = await freshConnection();
    await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount(), cardAccount()],
        transactions: {
          "prov-bank": [
            // Settles the leg posted two days earlier — the window exists for
            // exactly this, which is why the leg cannot be found again by date.
            tx({ id: "b-late", amount: -366.83, description: "PIX ENVIADO   Nu Pagamentos S A",
                 category: "Credit card payment", date: "2026-03-09T00:00:00.000Z" }),
          ],
          "prov-card": [
            tx({ id: "c-early", accountId: "prov-card", amount: -366.83, description: "Pagamento",
                 category: "Credit card payment", date: "2026-03-07T00:00:00.000Z" }),
            // A second open leg of the same value on the same card. The old
            // fallback marked every one of these settled by the single payment.
            tx({ id: "c-other", accountId: "prov-card", amount: -366.83, description: "Pagamento",
                 category: "Credit card payment", date: "2026-03-02T00:00:00.000Z" }),
          ],
        },
      }),
      now: NOW,
    });

    const legs = await db
      .select({ paidAt: openFinanceCardPayments.paidAt,
                matched: openFinanceCardPayments.matchedTransactionId })
      .from(openFinanceCardPayments)
      .where(eq(openFinanceCardPayments.userId, userId));

    expect(legs).toHaveLength(2);
    expect(legs.filter((leg) => leg.matched !== null)).toHaveLength(1);
    expect(legs.find((leg) => leg.matched !== null)?.paidAt).toBe("2026-03-07");
  });
});

describe("an investment label on a credit card", () => {
  it("is a gap, not a transfer, so the purchase stays visible as spending", async () => {
    const connectionId = await freshConnection();
    const summary = await syncConnection(userId, connectionId, {
      trigger: "manual",
      client: stubClient({
        accounts: [bankAccount(), cardAccount()],
        transactions: {
          // What Pluggy really sends: a marketplace purchase under `Investments`.
          "prov-card": [
            tx({ id: "ml", accountId: "prov-card", amount: 190.12,
                 description: "MERCADOLIVRE MERCADOL  GUARULHOS     BRA",
                 category: "Investments" }),
          ],
          // On a bank account the same label is a real movement.
          "prov-bank": [
            tx({ id: "cdb", amount: 294.33, type: "CREDIT",
                 description: "Resgate - Cdb Credito", category: "Investments" }),
          ],
        },
      }),
      now: NOW,
    });

    const [purchase] = await db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "ml")));
    expect(purchase!.categoryId).toBeNull();

    const [run] = await db
      .select({ stats: openFinanceSyncRuns.stats })
      .from(openFinanceSyncRuns)
      .where(eq(openFinanceSyncRuns.id, summary.runId!));
    // Surfaced as a gap worth filling rather than silently swallowed.
    expect(run!.stats.unmappedCategories).toContain("Investments");

    const [transferCategory] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.name, "Transferências")));
    const [redemption] = await db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.externalId, "cdb")));
    expect(redemption!.categoryId).toBe(transferCategory?.id ?? null);
  });
});
