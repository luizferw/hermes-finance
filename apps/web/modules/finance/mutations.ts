"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  accounts,
  balanceSnapshots,
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  db,
  financialReserves,
  installmentPlans,
  installments,
  paymentOptions,
  purchaseItems,
  purchasePlans,
  transactions,
} from "@kosh/db";
import { addDays, majorToMinor } from "@kosh/domain";
import {
  addStatementMonths,
  expandInstallmentTail,
  nominalCycleDueDates,
  nominalCycleFor,
} from "@hermes-finance/forecast";
import { requireUser } from "@/lib/session";
import { recomputeAccountBalances } from "@/modules/accounts/queries";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import { assertAccountsOwned, assertCategoriesOwned } from "@/modules/shared/ownership";
import {
  createBillingCycleSchema,
  createCreditCardSchema,
  createFinancialReserveSchema,
  createPaymentOptionSchema,
  createPurchaseItemSchema,
  createPurchasePlanSchema,
  reconcileBillingCycleSchema,
  registerCardPurchaseSchema,
  updateBillingCycleSchema,
  updateCreditCardSchema,
  updateFinancialReserveSchema,
  updatePaymentOptionSchema,
  updatePurchaseItemSchema,
  updatePurchasePlanSchema,
  upsertBalanceSnapshotSchema,
  type CreateBillingCycleInput,
  type CreateCreditCardInput,
  type CreateFinancialReserveInput,
  type CreatePaymentOptionInput,
  type CreatePurchaseItemInput,
  type CreatePurchasePlanInput,
  type ReconcileBillingCycleInput,
  type RegisterCardPurchaseInput,
  type UpdateBillingCycleInput,
  type UpdateCreditCardInput,
  type UpdateFinancialReserveInput,
  type UpdatePaymentOptionInput,
  type UpdatePurchaseItemInput,
  type UpdatePurchasePlanInput,
  type UpsertBalanceSnapshotInput,
} from "./validators";

function revalidateFinance() {
  revalidatePath("/overview");
}

// --- ownership helpers ---------------------------------------------------------
//
// balanceSnapshots and financialReserves carry their own userId; every other
// table here is a child reached by climbing its FK chain up to the row that
// does (creditCards.userId, purchasePlans.userId), exactly as `ownership.ts`
// does for accounts/categories/tags/bills/budgets.

async function loadOwnedReserve(userId: string, reserveId: string) {
  const row = await db.query.financialReserves.findFirst({
    where: and(eq(financialReserves.id, reserveId), eq(financialReserves.userId, userId)),
  });
  if (!row) throw new ApiError(404, "not_found", "Reserve not found.");
  return row;
}

async function loadOwnedCreditCard(userId: string, cardId: string) {
  const row = await db.query.creditCards.findFirst({
    where: and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)),
  });
  if (!row) throw new ApiError(404, "not_found", "Credit card not found.");
  return row;
}

async function loadOwnedBillingCycle(userId: string, cycleId: string) {
  const row = await db.query.creditCardBillingCycles.findFirst({
    where: eq(creditCardBillingCycles.id, cycleId),
    with: { creditCard: true },
  });
  if (!row || row.creditCard.userId !== userId) {
    throw new ApiError(404, "not_found", "Billing cycle not found.");
  }
  return row;
}

async function loadOwnedPurchasePlan(userId: string, planId: string) {
  const row = await db.query.purchasePlans.findFirst({
    where: and(eq(purchasePlans.id, planId), eq(purchasePlans.userId, userId)),
  });
  if (!row) throw new ApiError(404, "not_found", "Purchase plan not found.");
  return row;
}

async function loadOwnedPurchaseItem(userId: string, itemId: string) {
  const row = await db.query.purchaseItems.findFirst({
    where: eq(purchaseItems.id, itemId),
    with: { purchasePlan: true },
  });
  if (!row || row.purchasePlan.userId !== userId) {
    throw new ApiError(404, "not_found", "Purchase item not found.");
  }
  return row;
}

async function loadOwnedPaymentOption(userId: string, optionId: string) {
  const row = await db.query.paymentOptions.findFirst({
    where: eq(paymentOptions.id, optionId),
    with: { purchaseItem: { with: { purchasePlan: true } } },
  });
  if (!row || row.purchaseItem.purchasePlan.userId !== userId) {
    throw new ApiError(404, "not_found", "Payment option not found.");
  }
  return row;
}

// --- balance snapshots -----------------------------------------------------------

/** Records or corrects the observed balance of an account on a given date. */
export async function upsertBalanceSnapshot(input: UpsertBalanceSnapshotInput) {
  const user = await requireUser();
  const data = upsertBalanceSnapshotSchema.parse(input);
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, data.accountId), eq(accounts.userId, user.id)),
  });
  if (!account) throw new ApiError(404, "not_found", "Account not found.");

  const amountMinor = majorToMinor(data.amount, account.currencyCode);
  const [snapshot] = await db
    .insert(balanceSnapshots)
    .values({
      userId: user.id,
      accountId: data.accountId,
      amountMinor,
      observedAt: data.observedAt,
      source: data.source,
    })
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.observedAt],
      set: { amountMinor, source: data.source },
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "balance_snapshot.upserted",
    entityType: "balance_snapshot",
    entityId: snapshot!.id,
    data: { changed: ["amount", "observedAt"] },
  });
  revalidateFinance();
  return snapshot!;
}

// --- financial reserves ------------------------------------------------------------

export async function createFinancialReserve(input: CreateFinancialReserveInput) {
  const user = await requireUser();
  const data = createFinancialReserveSchema.parse(input);

  const [reserve] = await db
    .insert(financialReserves)
    .values({
      userId: user.id,
      name: data.name,
      kind: data.kind,
      amountMinor: majorToMinor(data.amount, data.currencyCode),
      currencyCode: data.currencyCode,
      isActive: data.isActive,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "financial_reserve.created",
    entityType: "financial_reserve",
    entityId: reserve!.id,
    data: { name: data.name },
  });
  revalidateFinance();
  return reserve!;
}

export async function updateFinancialReserve(reserveId: string, input: UpdateFinancialReserveInput) {
  const user = await requireUser();
  const data = updateFinancialReserveSchema.parse(input);
  const existing = await loadOwnedReserve(user.id, reserveId);
  const currency = data.currencyCode ?? existing.currencyCode;

  await db
    .update(financialReserves)
    .set({
      name: data.name ?? existing.name,
      kind: data.kind ?? existing.kind,
      amountMinor: data.amount !== undefined ? majorToMinor(data.amount, currency) : existing.amountMinor,
      currencyCode: currency,
      isActive: data.isActive ?? existing.isActive,
    })
    .where(eq(financialReserves.id, reserveId));

  await logAudit({
    userId: user.id,
    action: "financial_reserve.updated",
    entityType: "financial_reserve",
    entityId: reserveId,
    data: { changed: Object.keys(data) },
  });
  revalidateFinance();
}

export async function deleteFinancialReserve(reserveId: string) {
  const user = await requireUser();
  const existing = await loadOwnedReserve(user.id, reserveId);
  await db.delete(financialReserves).where(eq(financialReserves.id, reserveId));
  await logAudit({
    userId: user.id,
    action: "financial_reserve.deleted",
    entityType: "financial_reserve",
    entityId: reserveId,
    data: { name: existing.name },
  });
  revalidateFinance();
}

// --- credit cards ------------------------------------------------------------------

export async function createCreditCard(input: CreateCreditCardInput) {
  const user = await requireUser();
  const data = createCreditCardSchema.parse(input);
  await assertAccountsOwned(user.id, [data.accountId, data.paymentAccountId]);

  const [card] = await db
    .insert(creditCards)
    .values({
      userId: user.id,
      accountId: data.accountId,
      name: data.name,
      issuer: data.issuer,
      currencyCode: data.currencyCode,
      creditLimitMinor: majorToMinor(data.creditLimit, data.currencyCode),
      defaultClosingDay: data.defaultClosingDay,
      defaultDueDay: data.defaultDueDay,
      paymentAccountId: data.paymentAccountId ?? null,
      active: data.active,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "credit_card.created",
    entityType: "credit_card",
    entityId: card!.id,
    data: { name: data.name },
  });
  revalidateFinance();
  return card!;
}

export async function updateCreditCard(cardId: string, input: UpdateCreditCardInput) {
  const user = await requireUser();
  const data = updateCreditCardSchema.parse(input);
  const existing = await loadOwnedCreditCard(user.id, cardId);
  if (data.paymentAccountId !== undefined) await assertAccountsOwned(user.id, [data.paymentAccountId]);
  const currency = data.currencyCode ?? existing.currencyCode;

  await db
    .update(creditCards)
    .set({
      name: data.name ?? existing.name,
      issuer: data.issuer ?? existing.issuer,
      currencyCode: currency,
      creditLimitMinor:
        data.creditLimit !== undefined ? majorToMinor(data.creditLimit, currency) : existing.creditLimitMinor,
      defaultClosingDay: data.defaultClosingDay ?? existing.defaultClosingDay,
      defaultDueDay: data.defaultDueDay ?? existing.defaultDueDay,
      paymentAccountId: data.paymentAccountId === undefined ? existing.paymentAccountId : data.paymentAccountId,
      active: data.active ?? existing.active,
    })
    .where(eq(creditCards.id, cardId));

  await logAudit({
    userId: user.id,
    action: "credit_card.updated",
    entityType: "credit_card",
    entityId: cardId,
    data: { changed: Object.keys(data) },
  });
  revalidateFinance();
}

/** Deactivates a card instead of deleting it: its purchases/installments stay auditable. */
export async function archiveCreditCard(cardId: string) {
  const user = await requireUser();
  const existing = await loadOwnedCreditCard(user.id, cardId);
  await db.update(creditCards).set({ active: false }).where(eq(creditCards.id, cardId));
  await logAudit({
    userId: user.id,
    action: "credit_card.archived",
    entityType: "credit_card",
    entityId: cardId,
    data: { name: existing.name },
  });
  revalidateFinance();
}

/**
 * Puts an archived card back in the list. Archiving is this module's delete,
 * and one the UI cannot walk back is the same trap as no delete at all.
 */
export async function restoreCreditCard(cardId: string) {
  const user = await requireUser();
  const existing = await db.query.creditCards.findFirst({
    where: and(eq(creditCards.id, cardId), eq(creditCards.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Credit card not found.");
  await db.update(creditCards).set({ active: true }).where(eq(creditCards.id, cardId));
  await logAudit({
    userId: user.id,
    action: "credit_card.restored",
    entityType: "credit_card",
    entityId: cardId,
    data: { name: existing.name },
  });
  revalidateFinance();
}

// --- credit card billing cycles -----------------------------------------------------

export async function createBillingCycle(input: CreateBillingCycleInput) {
  const user = await requireUser();
  const data = createBillingCycleSchema.parse(input);
  const card = await loadOwnedCreditCard(user.id, data.creditCardId);
  const statementMonth = `${data.statementMonth}-01`;

  const [cycle] = await db
    .insert(creditCardBillingCycles)
    .values({
      creditCardId: card.id,
      statementMonth,
      openedAt: data.openedAt,
      closedAt: data.closedAt ?? null,
      dueAt: data.dueAt,
      confirmedTotalMinor: data.confirmedTotal != null ? majorToMinor(data.confirmedTotal, card.currencyCode) : null,
      source: data.source,
      status: data.status,
    })
    .onConflictDoUpdate({
      target: [creditCardBillingCycles.creditCardId, creditCardBillingCycles.statementMonth],
      set: {
        openedAt: data.openedAt,
        closedAt: data.closedAt ?? null,
        dueAt: data.dueAt,
        confirmedTotalMinor:
          data.confirmedTotal != null ? majorToMinor(data.confirmedTotal, card.currencyCode) : null,
        source: data.source,
        status: data.status,
      },
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "credit_card_cycle.created",
    entityType: "credit_card_billing_cycle",
    entityId: cycle!.id,
    data: { source: data.source },
  });
  revalidateFinance();
  return cycle!;
}

export async function updateBillingCycle(cycleId: string, input: UpdateBillingCycleInput) {
  const user = await requireUser();
  const data = updateBillingCycleSchema.parse(input);
  const existing = await loadOwnedBillingCycle(user.id, cycleId);

  await db
    .update(creditCardBillingCycles)
    .set({
      openedAt: data.openedAt ?? existing.openedAt,
      closedAt: data.closedAt === undefined ? existing.closedAt : data.closedAt,
      dueAt: data.dueAt ?? existing.dueAt,
      confirmedTotalMinor:
        data.confirmedTotal !== undefined
          ? data.confirmedTotal == null
            ? null
            : majorToMinor(data.confirmedTotal, existing.creditCard.currencyCode)
          : existing.confirmedTotalMinor,
      source: data.source ?? existing.source,
      status: data.status ?? existing.status,
    })
    .where(eq(creditCardBillingCycles.id, cycleId));

  await logAudit({
    userId: user.id,
    action: "credit_card_cycle.updated",
    entityType: "credit_card_billing_cycle",
    entityId: cycleId,
    data: { changed: Object.keys(data) },
  });
  revalidateFinance();
}

/** Marks a cycle's statement as arrived, with its confirmed real total. */
/**
 * Reconciles a billing cycle against the real statement (PRD §29).
 *
 * `confirmedTotal` is what the physical/PDF statement says. The system's own
 * expectation is the sum of installments it has billed to this cycle —
 * purchases it already knows about. Interest and fees have no dedicated
 * column yet, so a real fee shows up exactly as a discrepancy would: the two
 * numbers won't match. Rather than accept whatever total is typed in, a
 * mismatch forces `needs_review` regardless of what status was requested —
 * marking a cycle "paid" or "closed" when the numbers don't add up would be
 * worse than leaving it visibly unresolved.
 */
export async function reconcileBillingCycleCore(
  userId: string,
  cycleId: string,
  input: ReconcileBillingCycleInput,
) {
  const data = reconcileBillingCycleSchema.parse(input);
  const existing = await loadOwnedBillingCycle(userId, cycleId);

  const billed = await db.query.installments.findMany({
    where: and(eq(installments.billingCycleId, cycleId), ne(installments.status, "cancelled")),
  });
  const expectedMinor = billed.reduce((total, item) => total + item.amountMinor, 0);
  const confirmedTotalMinor = majorToMinor(data.confirmedTotal, existing.creditCard.currencyCode);
  const discrepancyMinor = confirmedTotalMinor - expectedMinor;
  const status = discrepancyMinor === 0 ? data.status : "needs_review";

  await db
    .update(creditCardBillingCycles)
    .set({ confirmedTotalMinor, status })
    .where(eq(creditCardBillingCycles.id, cycleId));

  await logAudit({
    userId,
    action: "credit_card_cycle.reconciled",
    entityType: "credit_card_billing_cycle",
    entityId: cycleId,
    data: { status, discrepancyMinor },
  });

  return { status, expectedMinor, confirmedTotalMinor, discrepancyMinor };
}

export async function reconcileBillingCycle(cycleId: string, input: ReconcileBillingCycleInput) {
  const user = await requireUser();
  const result = await reconcileBillingCycleCore(user.id, cycleId, input);
  revalidateFinance();
  return result;
}

// --- card purchases + installments --------------------------------------------------

type Trx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Finds the billing cycle a statement month already has, or opens one from
 * the card's nominal cycle math. Idempotent: a second purchase landing in the
 * same statement month reuses the row instead of duplicating it.
 */
async function findOrCreateBillingCycle(
  trx: Trx,
  card: { id: string; defaultClosingDay: number; defaultDueDay: number },
  statementMonth: string,
  dueAt: string,
): Promise<string> {
  const statementDate = `${statementMonth}-01`;
  const previousMonth = addStatementMonths(statementMonth, -1);
  const previousClosesAt = nominalCycleFor(
    `${previousMonth}-01`,
    card.defaultClosingDay,
    card.defaultDueDay,
  ).closesAt;
  const openedAt = addDays(previousClosesAt, 1);

  const [inserted] = await trx
    .insert(creditCardBillingCycles)
    .values({
      creditCardId: card.id,
      statementMonth: statementDate,
      openedAt,
      dueAt,
      status: "open",
    })
    .onConflictDoNothing({
      target: [creditCardBillingCycles.creditCardId, creditCardBillingCycles.statementMonth],
    })
    .returning({ id: creditCardBillingCycles.id });
  if (inserted) return inserted.id;

  const existing = await trx.query.creditCardBillingCycles.findFirst({
    where: and(
      eq(creditCardBillingCycles.creditCardId, card.id),
      eq(creditCardBillingCycles.statementMonth, statementDate),
    ),
    columns: { id: true },
  });
  return existing!.id;
}

/**
 * Records a card purchase, its installment plan, and every installment,
 * atomically. The purchase amount and the installment plan are the economic
 * facts; each installment is assigned to the billing cycle the card's own
 * closing/due days say it lands in (`nominalCycleFor`/`nominalCycleDueDates`
 * from `@hermes-finance/forecast` — the cycle math is never reimplemented
 * here). The last installment absorbs the rounding remainder
 * (`expandInstallmentTail`), so the parcels always sum to the purchase total
 * exactly.
 */
export async function registerCardPurchase(input: RegisterCardPurchaseInput) {
  const user = await requireUser();
  const data = registerCardPurchaseSchema.parse(input);
  const card = await loadOwnedCreditCard(user.id, data.creditCardId);
  if (data.categoryId) await assertCategoriesOwned(user.id, [data.categoryId]);

  const totalAmountMinor = majorToMinor(data.totalAmount, card.currencyCode);
  const firstCycle = nominalCycleFor(data.purchaseDate, card.defaultClosingDay, card.defaultDueDay);
  const dueDates = nominalCycleDueDates(
    data.purchaseDate,
    card.defaultClosingDay,
    card.defaultDueDay,
    data.totalInstallments,
  );
  // expandInstallmentTail projects the tail *after* `currentInstallmentNumber`,
  // so the anchor month is one before the first cycle this purchase lands in.
  const anchorStatementMonth = addStatementMonths(firstCycle.statementMonth, -1);
  const installmentAmountMinor = Math.round(totalAmountMinor / data.totalInstallments);
  const tail = expandInstallmentTail({
    totalInstallments: data.totalInstallments,
    currentInstallmentNumber: 0,
    installmentAmountMinor,
    currentStatementMonth: anchorStatementMonth,
    totalAmountMinor,
  });

  const result = await db.transaction(async (trx) => {
    const [purchaseTransaction] = await trx
      .insert(transactions)
      .values({
        userId: user.id,
        accountId: card.accountId,
        type: "expense",
        status: "posted",
        date: data.purchaseDate,
        amountMinor: -totalAmountMinor,
        currencyCode: card.currencyCode,
        description: data.description,
        merchant: data.merchant ?? null,
        categoryId: data.categoryId ?? null,
      })
      .returning();

    const [purchase] = await trx
      .insert(creditCardPurchases)
      .values({
        creditCardId: card.id,
        transactionId: purchaseTransaction!.id,
        purchaseDate: data.purchaseDate,
        categoryId: data.categoryId ?? null,
        merchant: data.merchant ?? null,
        totalAmountMinor,
      })
      .returning();

    const [plan] = await trx
      .insert(installmentPlans)
      .values({
        creditCardPurchaseId: purchase!.id,
        totalInstallments: data.totalInstallments,
        firstInstallmentNumber: 1,
      })
      .returning();

    const cycleIdByStatementMonth = new Map<string, string>();
    const createdInstallments: Array<typeof installments.$inferSelect> = [];
    for (let index = 0; index < tail.length; index += 1) {
      const entry = tail[index]!;
      const dueAt = dueDates[index]!;
      let cycleId = cycleIdByStatementMonth.get(entry.statementMonth);
      if (!cycleId) {
        cycleId = await findOrCreateBillingCycle(trx, card, entry.statementMonth, dueAt);
        cycleIdByStatementMonth.set(entry.statementMonth, cycleId);
      }
      const [installment] = await trx
        .insert(installments)
        .values({
          installmentPlanId: plan!.id,
          number: entry.number,
          amountMinor: entry.amountMinor,
          billingCycleId: cycleId,
          expectedAt: dueAt,
          status: "projected",
        })
        .returning();
      createdInstallments.push(installment!);
    }

    return {
      transaction: purchaseTransaction!,
      purchase: purchase!,
      plan: plan!,
      installments: createdInstallments,
    };
  });

  await logAudit({
    userId: user.id,
    action: "credit_card_purchase.registered",
    entityType: "credit_card_purchase",
    entityId: result.purchase.id,
    data: { count: data.totalInstallments },
  });
  await recomputeAccountBalances([card.accountId]);
  revalidateFinance();
  return result;
}

/**
 * Undoes a registration whole.
 *
 * The ledger soft-deletes transactions everywhere else, and that is wrong here:
 * a card purchase is one economic expense plus an installment plan that
 * projects into the forecast. Hiding the transaction behind `deletedAt` would
 * leave the plan and its installments alive, still landing on future statements
 * with nothing on screen to explain them. The purchase, its plan and its
 * installments all cascade from the transaction row, so deleting that row for
 * real is what actually reverses the registration.
 *
 * Billing cycles are deliberately left behind — they are shared by every
 * purchase on the card, and an empty one is harmless.
 */
export async function deleteCardPurchase(purchaseId: string) {
  const user = await requireUser();
  const purchase = await db.query.creditCardPurchases.findFirst({
    where: eq(creditCardPurchases.id, purchaseId),
  });
  if (!purchase) throw new ApiError(404, "not_found", "Card purchase not found.");
  const card = await loadOwnedCreditCard(user.id, purchase.creditCardId);

  await db.delete(transactions).where(eq(transactions.id, purchase.transactionId));

  await recomputeAccountBalances([card.accountId]);
  await logAudit({
    userId: user.id,
    action: "credit_card_purchase.deleted",
    entityType: "credit_card_purchase",
    entityId: purchaseId,
    data: { merchant: purchase.merchant, totalAmountMinor: purchase.totalAmountMinor },
  });
  revalidateFinance();
}

// --- purchase plans --------------------------------------------------------------

export async function createPurchasePlan(input: CreatePurchasePlanInput) {
  const user = await requireUser();
  const data = createPurchasePlanSchema.parse(input);

  const [plan] = await db
    .insert(purchasePlans)
    .values({
      userId: user.id,
      name: data.name,
      description: data.description,
      targetDate: data.targetDate ?? null,
      budgetMinor: data.budget != null ? majorToMinor(data.budget, data.currencyCode) : null,
      currencyCode: data.currencyCode,
      status: data.status,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "purchase_plan.created",
    entityType: "purchase_plan",
    entityId: plan!.id,
    data: { name: data.name },
  });
  revalidateFinance();
  return plan!;
}

export async function updatePurchasePlan(planId: string, input: UpdatePurchasePlanInput) {
  const user = await requireUser();
  const data = updatePurchasePlanSchema.parse(input);
  const existing = await loadOwnedPurchasePlan(user.id, planId);
  const currency = data.currencyCode ?? existing.currencyCode;

  await db
    .update(purchasePlans)
    .set({
      name: data.name ?? existing.name,
      description: data.description ?? existing.description,
      targetDate: data.targetDate === undefined ? existing.targetDate : data.targetDate,
      budgetMinor:
        data.budget !== undefined
          ? data.budget == null
            ? null
            : majorToMinor(data.budget, currency)
          : existing.budgetMinor,
      currencyCode: currency,
      status: data.status ?? existing.status,
    })
    .where(eq(purchasePlans.id, planId));

  await logAudit({
    userId: user.id,
    action: "purchase_plan.updated",
    entityType: "purchase_plan",
    entityId: planId,
    data: { changed: Object.keys(data) },
  });
  revalidateFinance();
}

export async function deletePurchasePlan(planId: string) {
  const user = await requireUser();
  const existing = await loadOwnedPurchasePlan(user.id, planId);
  await db.delete(purchasePlans).where(eq(purchasePlans.id, planId));
  await logAudit({
    userId: user.id,
    action: "purchase_plan.deleted",
    entityType: "purchase_plan",
    entityId: planId,
    data: { name: existing.name },
  });
  revalidateFinance();
}

// --- purchase items ----------------------------------------------------------------

export async function createPurchaseItem(input: CreatePurchaseItemInput) {
  const user = await requireUser();
  const data = createPurchaseItemSchema.parse(input);
  const plan = await loadOwnedPurchasePlan(user.id, data.purchasePlanId);

  const [item] = await db
    .insert(purchaseItems)
    .values({
      purchasePlanId: plan.id,
      name: data.name,
      priority: data.priority,
      estimatedPriceMinor: majorToMinor(data.estimatedPrice, plan.currencyCode),
      actualPriceMinor: data.actualPrice != null ? majorToMinor(data.actualPrice, plan.currencyCode) : null,
      earliestPurchaseDate: data.earliestPurchaseDate ?? null,
      deadline: data.deadline ?? null,
      status: data.status,
      notes: data.notes,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "purchase_item.created",
    entityType: "purchase_item",
    entityId: item!.id,
    data: { name: data.name },
  });
  revalidateFinance();
  return item!;
}

export async function updatePurchaseItem(itemId: string, input: UpdatePurchaseItemInput) {
  const user = await requireUser();
  const data = updatePurchaseItemSchema.parse(input);
  const existing = await loadOwnedPurchaseItem(user.id, itemId);
  const currency = existing.purchasePlan.currencyCode;

  await db
    .update(purchaseItems)
    .set({
      name: data.name ?? existing.name,
      priority: data.priority ?? existing.priority,
      estimatedPriceMinor:
        data.estimatedPrice !== undefined
          ? majorToMinor(data.estimatedPrice, currency)
          : existing.estimatedPriceMinor,
      actualPriceMinor:
        data.actualPrice !== undefined
          ? data.actualPrice == null
            ? null
            : majorToMinor(data.actualPrice, currency)
          : existing.actualPriceMinor,
      earliestPurchaseDate:
        data.earliestPurchaseDate === undefined ? existing.earliestPurchaseDate : data.earliestPurchaseDate,
      deadline: data.deadline === undefined ? existing.deadline : data.deadline,
      status: data.status ?? existing.status,
      notes: data.notes ?? existing.notes,
    })
    .where(eq(purchaseItems.id, itemId));

  await logAudit({
    userId: user.id,
    action: "purchase_item.updated",
    entityType: "purchase_item",
    entityId: itemId,
    data: { changed: Object.keys(data) },
  });
  revalidateFinance();
}

export async function deletePurchaseItem(itemId: string) {
  const user = await requireUser();
  const existing = await loadOwnedPurchaseItem(user.id, itemId);
  await db.delete(purchaseItems).where(eq(purchaseItems.id, itemId));
  await logAudit({
    userId: user.id,
    action: "purchase_item.deleted",
    entityType: "purchase_item",
    entityId: itemId,
    data: { name: existing.name },
  });
  revalidateFinance();
}

// --- payment options -----------------------------------------------------------------

export async function createPaymentOption(input: CreatePaymentOptionInput) {
  const user = await requireUser();
  const data = createPaymentOptionSchema.parse(input);
  const item = await loadOwnedPurchaseItem(user.id, data.purchaseItemId);
  const currency = item.purchasePlan.currencyCode;
  if (data.cardId) await loadOwnedCreditCard(user.id, data.cardId);

  const [option] = await db
    .insert(paymentOptions)
    .values({
      purchaseItemId: item.id,
      paymentMethod: data.paymentMethod,
      cardId: data.cardId ?? null,
      cashPriceMinor: data.cashPrice != null ? majorToMinor(data.cashPrice, currency) : null,
      installments: data.installments ?? null,
      installmentAmountMinor: data.installmentAmount != null ? majorToMinor(data.installmentAmount, currency) : null,
      totalCostMinor: majorToMinor(data.totalCost, currency),
      firstPaymentDate: data.firstPaymentDate ?? null,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "payment_option.created",
    entityType: "payment_option",
    entityId: option!.id,
    data: { source: data.paymentMethod },
  });
  revalidateFinance();
  return option!;
}

export async function updatePaymentOption(optionId: string, input: UpdatePaymentOptionInput) {
  const user = await requireUser();
  const data = updatePaymentOptionSchema.parse(input);
  const existing = await loadOwnedPaymentOption(user.id, optionId);
  const currency = existing.purchaseItem.purchasePlan.currencyCode;
  if (data.cardId) await loadOwnedCreditCard(user.id, data.cardId);

  await db
    .update(paymentOptions)
    .set({
      paymentMethod: data.paymentMethod ?? existing.paymentMethod,
      cardId: data.cardId === undefined ? existing.cardId : data.cardId,
      cashPriceMinor:
        data.cashPrice !== undefined
          ? data.cashPrice == null
            ? null
            : majorToMinor(data.cashPrice, currency)
          : existing.cashPriceMinor,
      installments: data.installments === undefined ? existing.installments : data.installments,
      installmentAmountMinor:
        data.installmentAmount !== undefined
          ? data.installmentAmount == null
            ? null
            : majorToMinor(data.installmentAmount, currency)
          : existing.installmentAmountMinor,
      totalCostMinor: data.totalCost !== undefined ? majorToMinor(data.totalCost, currency) : existing.totalCostMinor,
      firstPaymentDate: data.firstPaymentDate === undefined ? existing.firstPaymentDate : data.firstPaymentDate,
    })
    .where(eq(paymentOptions.id, optionId));

  await logAudit({
    userId: user.id,
    action: "payment_option.updated",
    entityType: "payment_option",
    entityId: optionId,
    data: { changed: Object.keys(data) },
  });
  revalidateFinance();
}

export async function deletePaymentOption(optionId: string) {
  const user = await requireUser();
  await loadOwnedPaymentOption(user.id, optionId);
  await db.delete(paymentOptions).where(eq(paymentOptions.id, optionId));
  await logAudit({
    userId: user.id,
    action: "payment_option.deleted",
    entityType: "payment_option",
    entityId: optionId,
  });
  revalidateFinance();
}
