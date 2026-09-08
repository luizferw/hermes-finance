/**
 * PRD §83 acceptance scenario fixture.
 *
 * Seeds the exact end-to-end example the product's first acceptance scenario
 * is built on: two checking accounts with an observed balance, a salary and
 * a handful of committed bills, four credit cards (one with a confirmed
 * statement plus an installment purchase, one with just a confirmed
 * statement, two store cards paying off purchases in installments), a hard
 * reserve, and a purchase plan ("Enxoval") with one item carrying three
 * payment options (PIX, 5x, 10x). Every amount is stored in integer minor
 * units (centavos) — never a float.
 *
 * Idempotent: like the demo seed, the fixture user is deleted by email and
 * recreated on every run, so a second run reproduces the exact same rows
 * instead of duplicating them.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "better-auth/crypto";
import { addDays, majorToMinor, todayIso } from "@kosh/domain";
import { addStatementMonths, expandInstallmentTail, nominalCycleDueDates, nominalCycleFor } from "@hermes-finance/forecast";
import * as schema from "./schema";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env"), quiet: true });

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://kosh:kosh@localhost:5432/kosh";
const FIXTURE_EMAIL = "prd-scenario@kosh.local";
const FIXTURE_PASSWORD = "prd-scenario-2026";
const CURRENCY = "BRL";

type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Registers a card purchase, its installment plan, and every installment in
 * one transaction — the same math `registerCardPurchase`
 * (apps/web/modules/finance/mutations.ts) uses: `nominalCycleFor`/
 * `nominalCycleDueDates` place each installment in its billing cycle, and
 * `expandInstallmentTail` splits the total so the last installment absorbs
 * the rounding remainder. Reimplemented locally because the seed script runs
 * outside any request/session, so the `"use server"` mutation (which calls
 * `requireUser()`) cannot be invoked here.
 */
async function seedCardPurchase(
  db: Database,
  card: { id: string; accountId: string; currencyCode: string; defaultClosingDay: number; defaultDueDay: number },
  purchase: { purchaseDate: string; totalAmountMajor: number; totalInstallments: number; description: string; merchant?: string },
) {
  const totalAmountMinor = majorToMinor(purchase.totalAmountMajor, card.currencyCode);
  const firstCycle = nominalCycleFor(purchase.purchaseDate, card.defaultClosingDay, card.defaultDueDay);
  const dueDates = nominalCycleDueDates(
    purchase.purchaseDate,
    card.defaultClosingDay,
    card.defaultDueDay,
    purchase.totalInstallments,
  );
  const anchorStatementMonth = addStatementMonths(firstCycle.statementMonth, -1);
  const installmentAmountMinor = Math.round(totalAmountMinor / purchase.totalInstallments);
  const tail = expandInstallmentTail({
    totalInstallments: purchase.totalInstallments,
    currentInstallmentNumber: 0,
    installmentAmountMinor,
    currentStatementMonth: anchorStatementMonth,
    totalAmountMinor,
  });

  await db.transaction(async (trx) => {
    const [tx] = await trx
      .insert(schema.transactions)
      .values({
        id: randomUUID(),
        userId: (await trx.query.creditCards.findFirst({ where: eq(schema.creditCards.id, card.id) }))!.userId,
        accountId: card.accountId,
        type: "expense",
        status: "posted",
        date: purchase.purchaseDate,
        amountMinor: -totalAmountMinor,
        currencyCode: card.currencyCode,
        description: purchase.description,
        merchant: purchase.merchant ?? null,
      })
      .returning();

    // `accounts.current_balance_minor` is stored, not derived, so a seeded
    // purchase must move it exactly as the app would. Without this the card
    // carries purchases while its account reads zero, and every figure derived
    // from the balance — committed amount, available limit — is silently wrong.
    await trx
      .update(schema.accounts)
      .set({
        currentBalanceMinor: sql`${schema.accounts.currentBalanceMinor} - ${totalAmountMinor}`,
      })
      .where(eq(schema.accounts.id, card.accountId));

    const [created] = await trx
      .insert(schema.creditCardPurchases)
      .values({
        id: randomUUID(),
        creditCardId: card.id,
        transactionId: tx!.id,
        purchaseDate: purchase.purchaseDate,
        merchant: purchase.merchant ?? null,
        totalAmountMinor,
      })
      .returning();

    const [plan] = await trx
      .insert(schema.installmentPlans)
      .values({
        id: randomUUID(),
        creditCardPurchaseId: created!.id,
        totalInstallments: purchase.totalInstallments,
        firstInstallmentNumber: 1,
      })
      .returning();

    const cycleIdByStatementMonth = new Map<string, string>();
    for (let index = 0; index < tail.length; index += 1) {
      const entry = tail[index]!;
      const dueAt = dueDates[index]!;
      let cycleId = cycleIdByStatementMonth.get(entry.statementMonth);
      if (!cycleId) {
        cycleId = await openBillingCycle(trx, card, entry.statementMonth, dueAt);
        cycleIdByStatementMonth.set(entry.statementMonth, cycleId);
      }
      await trx.insert(schema.installments).values({
        id: randomUUID(),
        installmentPlanId: plan!.id,
        number: entry.number,
        amountMinor: entry.amountMinor,
        billingCycleId: cycleId,
        expectedAt: dueAt,
        status: "projected",
      });
    }
  });
}

async function openBillingCycle(
  trx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  card: { id: string; defaultClosingDay: number; defaultDueDay: number },
  statementMonth: string,
  dueAt: string,
): Promise<string> {
  const statementDate = `${statementMonth}-01`;
  const existing = await trx.query.creditCardBillingCycles.findFirst({
    where: and(
      eq(schema.creditCardBillingCycles.creditCardId, card.id),
      eq(schema.creditCardBillingCycles.statementMonth, statementDate),
    ),
  });
  if (existing) return existing.id;

  const previousMonth = addStatementMonths(statementMonth, -1);
  const previousClosesAt = nominalCycleFor(`${previousMonth}-01`, card.defaultClosingDay, card.defaultDueDay).closesAt;
  const openedAt = addDays(previousClosesAt, 1);

  const [cycle] = await trx
    .insert(schema.creditCardBillingCycles)
    .values({
      id: randomUUID(),
      creditCardId: card.id,
      statementMonth: statementDate,
      openedAt,
      dueAt,
      status: "open",
    })
    .returning();
  return cycle!.id;
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const db = drizzle(pool, { schema });
  console.log("Seeding PRD §83 scenario...");

  // --- user (wipe + recreate; everything else cascades) -------------------
  await db.delete(schema.users).where(eq(schema.users.email, FIXTURE_EMAIL));
  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    name: "Cenário PRD",
    email: FIXTURE_EMAIL,
    emailVerified: true,
  });
  await db.insert(schema.authAccounts).values({
    id: randomUUID(),
    userId,
    accountId: userId,
    providerId: "credential",
    password: await hashPassword(FIXTURE_PASSWORD),
  });
  await db.insert(schema.userSettings).values({
    userId,
    country: "BR",
    currencyCode: CURRENCY,
    locale: "pt-BR",
  });

  const today = todayIso();

  // --- checking accounts + observed balances -------------------------------
  const mkAccount = async (values: Omit<typeof schema.accounts.$inferInsert, "userId" | "id">) => {
    const id = randomUUID();
    await db.insert(schema.accounts).values({ ...values, id, userId });
    return id;
  };

  const santanderId = await mkAccount({
    name: "Santander",
    type: "asset",
    currencyCode: CURRENCY,
    institution: "Santander",
    openingBalanceMinor: majorToMinor(4_500, CURRENCY),
    openingBalanceDate: today,
    currentBalanceMinor: majorToMinor(4_500, CURRENCY),
  });
  const interId = await mkAccount({
    name: "Inter",
    type: "asset",
    currencyCode: CURRENCY,
    institution: "Banco Inter",
    openingBalanceMinor: majorToMinor(3_000, CURRENCY),
    openingBalanceDate: today,
    currentBalanceMinor: majorToMinor(3_000, CURRENCY),
  });

  await db.insert(schema.balanceSnapshots).values([
    { id: randomUUID(), userId, accountId: santanderId, amountMinor: majorToMinor(4_500, CURRENCY), observedAt: today, source: "manual" },
    { id: randomUUID(), userId, accountId: interId, amountMinor: majorToMinor(3_000, CURRENCY), observedAt: today, source: "manual" },
  ]);

  // --- salary (recurring income) --------------------------------------------
  await db.insert(schema.recurringTransactions).values({
    id: randomUUID(),
    userId,
    name: "Salário",
    type: "income",
    accountId: interId,
    amountMinor: majorToMinor(7_500, CURRENCY),
    currencyCode: CURRENCY,
    description: "Salário mensal",
    interval: "monthly",
    nextRunDate: `${today.slice(0, 7)}-25`,
    isActive: true,
  });

  // --- bills: aluguel (fixed), internet (fixed), energia (variable estimate) -
  await db.insert(schema.bills).values([
    {
      id: randomUUID(),
      userId,
      name: "Aluguel",
      expectedAmountMinor: majorToMinor(1_800, CURRENCY),
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 10,
      nextDueDate: `${today.slice(0, 7)}-10`,
      accountId: santanderId,
    },
    {
      id: randomUUID(),
      userId,
      name: "Internet",
      expectedAmountMinor: majorToMinor(120, CURRENCY),
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 15,
      nextDueDate: `${today.slice(0, 7)}-15`,
      accountId: interId,
    },
    {
      id: randomUUID(),
      userId,
      name: "Energia",
      expectedAmountMinor: majorToMinor(180, CURRENCY),
      currencyCode: CURRENCY,
      recurrence: "monthly",
      dueDay: 20,
      nextDueDate: `${today.slice(0, 7)}-20`,
      accountId: interId,
      notes: "Valor variável; estimativa baseada no histórico de consumo.",
    },
  ]);

  // --- hard reserve -----------------------------------------------------------
  await db.insert(schema.financialReserves).values({
    id: randomUUID(),
    userId,
    name: "Reserva de emergência",
    kind: "hard",
    amountMinor: majorToMinor(1_500, CURRENCY),
    currencyCode: CURRENCY,
    isActive: true,
  });

  // --- credit cards -------------------------------------------------------------
  const mkCardAccount = (name: string) =>
    mkAccount({ name, type: "credit_card", currencyCode: CURRENCY, includeInNetWorth: false });

  const interCardAccountId = await mkCardAccount("Inter Cartão");
  const santanderCardAccountId = await mkCardAccount("Santander Cartão");
  const rennerCardAccountId = await mkCardAccount("Renner");
  const havanCardAccountId = await mkCardAccount("Havan");

  const mkCard = async (values: {
    name: string;
    accountId: string;
    paymentAccountId?: string;
    defaultClosingDay: number;
    defaultDueDay: number;
    creditLimitMajor: number;
  }) => {
    const id = randomUUID();
    await db.insert(schema.creditCards).values({
      id,
      userId,
      accountId: values.accountId,
      name: values.name,
      currencyCode: CURRENCY,
      creditLimitMinor: majorToMinor(values.creditLimitMajor, CURRENCY),
      defaultClosingDay: values.defaultClosingDay,
      defaultDueDay: values.defaultDueDay,
      paymentAccountId: values.paymentAccountId ?? null,
      active: true,
    });
    return { id, accountId: values.accountId, currencyCode: CURRENCY, defaultClosingDay: values.defaultClosingDay, defaultDueDay: values.defaultDueDay };
  };

  const interCard = await mkCard({
    name: "Inter",
    accountId: interCardAccountId,
    paymentAccountId: interId,
    defaultClosingDay: 5,
    defaultDueDay: 12,
    creditLimitMajor: 5_000,
  });
  const santanderCard = await mkCard({
    name: "Santander",
    accountId: santanderCardAccountId,
    paymentAccountId: santanderId,
    defaultClosingDay: 10,
    defaultDueDay: 20,
    creditLimitMajor: 4_000,
  });
  const rennerCard = await mkCard({
    name: "Renner",
    accountId: rennerCardAccountId,
    defaultClosingDay: 1,
    defaultDueDay: 10,
    creditLimitMajor: 2_000,
  });
  const havanCard = await mkCard({
    name: "Havan",
    accountId: havanCardAccountId,
    defaultClosingDay: 15,
    defaultDueDay: 25,
    creditLimitMajor: 2_000,
  });

  // Inter: an already-confirmed statement (fatura) plus an ongoing installment
  // purchase (parcelas), landing in later billing cycles.
  const interPreviousStatementMonth = addStatementMonths(nominalCycleFor(today, interCard.defaultClosingDay, interCard.defaultDueDay).statementMonth, -1);
  const interPreviousCycle = nominalCycleFor(`${interPreviousStatementMonth}-01`, interCard.defaultClosingDay, interCard.defaultDueDay);
  const interCycleBeforeThat = nominalCycleFor(
    `${addStatementMonths(interPreviousStatementMonth, -1)}-01`,
    interCard.defaultClosingDay,
    interCard.defaultDueDay,
  );
  await db.insert(schema.creditCardBillingCycles).values({
    id: randomUUID(),
    creditCardId: interCard.id,
    statementMonth: `${interPreviousStatementMonth}-01`,
    openedAt: addDays(interCycleBeforeThat.closesAt, 1),
    closedAt: interPreviousCycle.closesAt,
    dueAt: interPreviousCycle.dueAt,
    confirmedTotalMinor: majorToMinor(680, CURRENCY),
    source: "manual",
    status: "closed",
  });
  await seedCardPurchase(db, interCard, {
    purchaseDate: today,
    totalAmountMajor: 1_800,
    totalInstallments: 6,
    description: "Notebook",
    merchant: "Fast Shop",
  });

  // Santander: just a confirmed statement.
  const santanderPreviousStatementMonth = addStatementMonths(
    nominalCycleFor(today, santanderCard.defaultClosingDay, santanderCard.defaultDueDay).statementMonth,
    -1,
  );
  const santanderPreviousCycle = nominalCycleFor(
    `${santanderPreviousStatementMonth}-01`,
    santanderCard.defaultClosingDay,
    santanderCard.defaultDueDay,
  );
  const santanderCycleBeforeThat = nominalCycleFor(
    `${addStatementMonths(santanderPreviousStatementMonth, -1)}-01`,
    santanderCard.defaultClosingDay,
    santanderCard.defaultDueDay,
  );
  await db.insert(schema.creditCardBillingCycles).values({
    id: randomUUID(),
    creditCardId: santanderCard.id,
    statementMonth: `${santanderPreviousStatementMonth}-01`,
    openedAt: addDays(santanderCycleBeforeThat.closesAt, 1),
    closedAt: santanderPreviousCycle.closesAt,
    dueAt: santanderPreviousCycle.dueAt,
    confirmedTotalMinor: majorToMinor(450, CURRENCY),
    source: "manual",
    status: "closed",
  });

  // Renner and Havan: store cards paying off a purchase in installments.
  await seedCardPurchase(db, rennerCard, {
    purchaseDate: today,
    totalAmountMajor: 1_200,
    totalInstallments: 10,
    description: "Guarda-roupa",
    merchant: "Renner",
  });
  await seedCardPurchase(db, havanCard, {
    purchaseDate: today,
    totalAmountMajor: 900,
    totalInstallments: 6,
    description: "Berço",
    merchant: "Havan",
  });

  // --- purchase plan: Enxoval > Carrinho > 3 payment options -------------------
  const [enxoval] = await db
    .insert(schema.purchasePlans)
    .values({
      id: randomUUID(),
      userId,
      name: "Enxoval",
      currencyCode: CURRENCY,
      status: "active",
    })
    .returning();

  const [carrinho] = await db
    .insert(schema.purchaseItems)
    .values({
      id: randomUUID(),
      purchasePlanId: enxoval!.id,
      name: "Carrinho",
      priority: "high",
      estimatedPriceMinor: majorToMinor(2_500, CURRENCY),
      status: "planned",
    })
    .returning();

  await db.insert(schema.paymentOptions).values([
    {
      id: randomUUID(),
      purchaseItemId: carrinho!.id,
      paymentMethod: "pix",
      cashPriceMinor: majorToMinor(2_250, CURRENCY),
      totalCostMinor: majorToMinor(2_250, CURRENCY),
      firstPaymentDate: today,
    },
    {
      id: randomUUID(),
      purchaseItemId: carrinho!.id,
      paymentMethod: "credit_card",
      cardId: interCard.id,
      installments: 5,
      installmentAmountMinor: majorToMinor(500, CURRENCY),
      totalCostMinor: majorToMinor(2_500, CURRENCY),
    },
    {
      id: randomUUID(),
      purchaseItemId: carrinho!.id,
      paymentMethod: "credit_card",
      cardId: interCard.id,
      installments: 10,
      installmentAmountMinor: majorToMinor(270, CURRENCY),
      totalCostMinor: majorToMinor(2_700, CURRENCY),
    },
  ]);

  console.log(`Seeded PRD §83 scenario for ${FIXTURE_EMAIL}.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
