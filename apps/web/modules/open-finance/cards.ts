import "server-only";
import { and, eq } from "drizzle-orm";
import {
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  installmentPlans,
  installments,
} from "@kosh/db";
import {
  expandInstallmentTail,
  nominalCycleFor,
  nominalCycleDueDates,
  statementMonthForDueDate,
} from "@hermes-finance/forecast";
import {
  uniqueAccountName,
  type NormalizedAccount,
  type NormalizedBill,
  type NormalizedTransaction,
} from "@hermes-finance/open-finance";
import type { Trx } from "./types";

/**
 * Create the `credit_cards` profile behind an auto-created card account.
 *
 * Refuses to create one when the closing and due days cannot be determined.
 * Every installment date and every statement projection is derived from those
 * two numbers, so a guessed closing day silently misdates a whole plan — PRD
 * §10 makes the point that buying on the 24th versus the 26th with a closing on
 * the 25th differs by an entire month.
 */
export async function ensureCreditCard(
  trx: Trx,
  userId: string,
  accountId: string,
  incoming: NormalizedAccount,
  bills: readonly NormalizedBill[],
): Promise<{ creditCardId: string | null; reason: string | null }> {
  const existing = await trx.query.creditCards.findFirst({
    where: eq(creditCards.accountId, accountId),
  });
  if (existing) return { creditCardId: existing.id, reason: null };

  const days = resolveCycleDays(incoming, bills);
  if (!days) {
    return {
      creditCardId: null,
      reason: "could not determine the closing and due days for this card",
    };
  }

  const taken = await trx
    .select({ name: creditCards.name })
    .from(creditCards)
    .where(eq(creditCards.userId, userId));

  const [created] = await trx
    .insert(creditCards)
    .values({
      userId,
      accountId,
      name: uniqueAccountName(incoming.name, new Set(taken.map((row) => row.name))),
      issuer: incoming.brand,
      currencyCode: incoming.currencyCode,
      creditLimitMinor: incoming.creditLimitMinor ?? 0,
      defaultClosingDay: days.closingDay,
      defaultDueDay: days.dueDay,
    })
    .returning({ id: creditCards.id });

  return { creditCardId: created!.id, reason: null };
}

/**
 * The card's closing and due day.
 *
 * `creditData` describes the bill that is open right now, which is the most
 * current answer. A card between cycles may not carry it, so the most recent
 * bill is the fallback — same two numbers, one cycle older.
 */
function resolveCycleDays(
  incoming: NormalizedAccount,
  bills: readonly NormalizedBill[],
): { closingDay: number; dueDay: number } | null {
  if (incoming.closingDay && incoming.dueDay) {
    return { closingDay: incoming.closingDay, dueDay: incoming.dueDay };
  }
  const latest = [...bills].sort((left, right) => right.dueAt.localeCompare(left.dueAt))[0];
  if (latest?.closedAt) {
    return {
      closingDay: Number(latest.closedAt.slice(8, 10)),
      dueDay: Number(latest.dueAt.slice(8, 10)),
    };
  }
  return null;
}

/**
 * Turn provider bills into billing cycles.
 *
 * The statement month comes from `nominalCycleFor`, the same function
 * `registerCardPurchase` and `deriveLedgerCycles` use. Deriving it from the due
 * date instead would key a second, parallel cycle for a month that already has
 * one, and the same money would be counted twice (PRD R3).
 *
 * Writing `confirmedTotalMinor` is the whole point of this path: `projectStatements`
 * reads it and rates the statement CONFIRMED instead of HIGH, with no change to
 * the forecast package at all (§51, R1).
 */
export async function syncBills(
  trx: Trx,
  creditCardId: string,
  closingDay: number,
  dueDay: number,
  bills: readonly NormalizedBill[],
  today: string,
): Promise<number> {
  let written = 0;

  for (const bill of bills) {
    // Keyed off the due date, not the closing date. A real closing date drifts
    // off the nominal day — a card closing on the 2nd closes on the 3rd when
    // the 2nd falls on a Sunday — and feeding that to `nominalCycleFor` pushes
    // the statement a month forward while the due date stays, producing a cycle
    // due before its own statement month.
    const statementMonth = `${statementMonthForDueDate(bill.dueAt, closingDay, dueDay)}-01`;

    const status = bill.isPaid
      ? "paid"
      : bill.closedAt && bill.dueAt < today
        ? "overdue"
        : bill.closedAt
          ? "closed"
          : "open";

    const [row] = await trx
      .insert(creditCardBillingCycles)
      .values({
        creditCardId,
        statementMonth,
        openedAt: previousDay(bill.closedAt ?? bill.dueAt, 30),
        closedAt: bill.closedAt,
        dueAt: bill.dueAt,
        confirmedTotalMinor: bill.totalMinor,
        source: "pluggy",
        status,
      })
      .onConflictDoUpdate({
        target: [creditCardBillingCycles.creditCardId, creditCardBillingCycles.statementMonth],
        set: {
          closedAt: bill.closedAt,
          dueAt: bill.dueAt,
          confirmedTotalMinor: bill.totalMinor,
          source: "pluggy",
          status,
        },
      })
      .returning({ id: creditCardBillingCycles.id });

    if (row) written += 1;
  }

  return written;
}

/**
 * Record a card charge as a purchase, and its installment plan if it has one.
 *
 * Pluggy emits one transaction per parcel, not one for the whole purchase, so
 * the naive reading — treat every parcel's `totalAmount` as a purchase — would
 * create M purchases of the full amount. Instead the first parcel seen owns the
 * purchase and the plan, and later parcels only mark their own installment as
 * billed.
 *
 * No cash event is emitted per installment. `projectStatements` emits one event
 * per cycle (docs/DOMAIN.md), and the installments feed that cycle's total and
 * the card's limit usage — nothing else (R3, R4).
 */
export async function registerSyncedPurchase(
  trx: Trx,
  args: {
    creditCardId: string;
    closingDay: number;
    dueDay: number;
    transactionId: string;
    row: NormalizedTransaction;
  },
): Promise<{ plansWritten: number }> {
  const { row } = args;
  const totalAmountMinor = Math.abs(row.amountMinor);

  const existingPurchase = await trx.query.creditCardPurchases.findFirst({
    where: eq(creditCardPurchases.transactionId, args.transactionId),
  });
  if (existingPurchase) return { plansWritten: 0 };

  // A later parcel of a plan we already know about: mark it billed, do not
  // create a second purchase for the same goods.
  if (row.installment) {
    const claimed = await claimExistingInstallment(trx, args);
    if (claimed) return { plansWritten: 0 };
  }

  const [purchase] = await trx
    .insert(creditCardPurchases)
    .values({
      creditCardId: args.creditCardId,
      transactionId: args.transactionId,
      purchaseDate: row.date,
      merchant: row.merchant,
      totalAmountMinor: row.installment?.totalAmountMinor ?? totalAmountMinor,
    })
    .returning({ id: creditCardPurchases.id });
  if (!purchase) return { plansWritten: 0 };

  if (!row.installment) return { plansWritten: 0 };

  const [plan] = await trx
    .insert(installmentPlans)
    .values({
      creditCardPurchaseId: purchase.id,
      totalInstallments: row.installment.total,
      // The plan may be joined mid-stream: the provider only holds twelve
      // months, so parcel 4 of 10 can be the first one ever seen. The column
      // exists for exactly this.
      firstInstallmentNumber: row.installment.number,
    })
    .returning({ id: installmentPlans.id });
  if (!plan) return { plansWritten: 0 };

  const dueDates = nominalCycleDueDates(
    row.date,
    args.closingDay,
    args.dueDay,
    row.installment.total - row.installment.number + 1,
  );

  const tail = expandInstallmentTail({
    totalInstallments: row.installment.total,
    currentInstallmentNumber: row.installment.number,
    installmentAmountMinor: totalAmountMinor,
    currentStatementMonth: nominalCycleFor(row.date, args.closingDay, args.dueDay).statementMonth,
    totalAmountMinor: row.installment.totalAmountMinor ?? undefined,
  });

  await trx.insert(installments).values([
    {
      installmentPlanId: plan.id,
      number: row.installment.number,
      amountMinor: totalAmountMinor,
      expectedAt: dueDates[0]!,
      status: "billed" as const,
      transactionId: args.transactionId,
    },
    ...tail.map((entry, index) => ({
      installmentPlanId: plan.id,
      number: entry.number,
      amountMinor: entry.amountMinor,
      expectedAt: dueDates[index + 1] ?? dueDates[dueDates.length - 1]!,
      status: "projected" as const,
    })),
  ]);

  return { plansWritten: 1 };
}

/**
 * Mark an already-projected installment as billed when its charge arrives.
 *
 * The plan is found through the sibling transactions of the same card that carry
 * the provider's installment tag, which is how two parcels of the same purchase
 * recognise each other across syncs.
 */
async function claimExistingInstallment(
  trx: Trx,
  args: { creditCardId: string; transactionId: string; row: NormalizedTransaction },
): Promise<boolean> {
  const { row } = args;
  if (!row.installment) return false;

  const plans = await trx
    .select({
      planId: installmentPlans.id,
      totalInstallments: installmentPlans.totalInstallments,
      totalAmountMinor: creditCardPurchases.totalAmountMinor,
      merchant: creditCardPurchases.merchant,
    })
    .from(installmentPlans)
    .innerJoin(
      creditCardPurchases,
      eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId),
    )
    .where(
      and(
        eq(creditCardPurchases.creditCardId, args.creditCardId),
        eq(installmentPlans.totalInstallments, row.installment.total),
      ),
    );

  const wantedTotal = row.installment.totalAmountMinor;
  const match = plans.find(
    (plan) =>
      (wantedTotal === null || plan.totalAmountMinor === wantedTotal) &&
      (row.merchant === null || plan.merchant === row.merchant),
  );
  if (!match) return false;

  const [updated] = await trx
    .update(installments)
    .set({ status: "billed", amountMinor: Math.abs(row.amountMinor), transactionId: args.transactionId })
    .where(
      and(
        eq(installments.installmentPlanId, match.planId),
        eq(installments.number, row.installment.number),
      ),
    )
    .returning({ id: installments.id });

  return Boolean(updated);
}

/**
 * Compare each bill's confirmed total against the charges the provider itself
 * assigned to it.
 *
 * The grouping is Pluggy's own `creditCardMetadata.billId`, not a date window we
 * inferred, so a mismatch really means the numbers disagree rather than that we
 * bucketed a charge into the wrong month.
 *
 * A difference is never resolved here. PRD §29 wants the cycle marked
 * `needs_review` so a person looks at it: the gap is usually a fee, an interest
 * charge or a missing purchase, and only a human can name which.
 */
export async function flagUnreconciledCycles(
  trx: Trx,
  creditCardId: string,
  closingDay: number,
  dueDay: number,
  bills: readonly NormalizedBill[],
  rows: readonly NormalizedTransaction[],
): Promise<number> {
  const chargedByBill = new Map<string, number>();
  for (const row of rows) {
    if (!row.billExternalId) continue;
    chargedByBill.set(
      row.billExternalId,
      (chargedByBill.get(row.billExternalId) ?? 0) + Math.abs(row.amountMinor),
    );
  }

  let flagged = 0;
  for (const bill of bills) {
    const charged = chargedByBill.get(bill.externalId);
    // No charges attributed to this bill means the provider did not link them,
    // not that the bill is empty. Saying "needs review" there would cry wolf.
    if (charged === undefined || charged === bill.totalMinor) continue;

    const statementMonth = statementMonthForDueDate(bill.dueAt, closingDay, dueDay);
    await trx
      .update(creditCardBillingCycles)
      .set({ status: "needs_review" })
      .where(
        and(
          eq(creditCardBillingCycles.creditCardId, creditCardId),
          eq(creditCardBillingCycles.statementMonth, `${statementMonth}-01`),
        ),
      );
    flagged += 1;
  }
  return flagged;
}

/** `2026-03-08` minus 30 days, the conventional start of a monthly cycle. */
function previousDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
