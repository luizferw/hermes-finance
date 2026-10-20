import "server-only";
import { and, asc, count, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import {
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  installmentPlans,
  installments,
  transactionMetadata,
  transactions,
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
 * Keep a linked card's closing and due days on what its published bills show.
 *
 * The days are captured once, when the card profile is created, from the
 * provider's description of the open bill — and that description can be wrong
 * or go stale: one real card was configured closing 25 / due 2 while every bill
 * it published was due on the 10th. Every date the app derives for the card
 * (which statement a purchase lands on, when a parcel falls due, when
 * safe-to-spend expects a purchase to be paid) comes from these two numbers, so
 * a published bill — a fact — wins over the configuration for a card Open
 * Finance manages.
 *
 * A real closing or due date drifts a day or three off the nominal one around
 * weekends and holidays, so a configured day within three days of any of the
 * latest three observations is left alone; only a disagreement that drift
 * cannot explain moves it, to the most frequent recent observation (the latest
 * on a tie).
 *
 * Provider cycles are keyed by statement month, which these days decide; when
 * they change, the existing provider cycles are re-keyed so the next sync
 * updates them instead of opening a second cycle for the same bill.
 */
export async function reconcileCycleDays(
  trx: Trx,
  card: { id: string; defaultClosingDay: number; defaultDueDay: number },
  bills: readonly NormalizedBill[],
): Promise<{ closingDay: number; dueDay: number; changed: boolean }> {
  const latest = [...bills].sort((left, right) => right.dueAt.localeCompare(left.dueAt)).slice(0, 3);
  const closingDay = observedDay(
    card.defaultClosingDay,
    latest.flatMap((bill) => (bill.closedAt ? [Number(bill.closedAt.slice(8, 10))] : [])),
  );
  const dueDay = observedDay(
    card.defaultDueDay,
    latest.map((bill) => Number(bill.dueAt.slice(8, 10))),
  );
  if (closingDay === card.defaultClosingDay && dueDay === card.defaultDueDay) {
    return { closingDay, dueDay, changed: false };
  }

  await trx
    .update(creditCards)
    .set({ defaultClosingDay: closingDay, defaultDueDay: dueDay })
    .where(eq(creditCards.id, card.id));

  const cycles = await trx
    .select({
      id: creditCardBillingCycles.id,
      statementMonth: creditCardBillingCycles.statementMonth,
      dueAt: creditCardBillingCycles.dueAt,
    })
    .from(creditCardBillingCycles)
    .where(
      and(
        eq(creditCardBillingCycles.creditCardId, card.id),
        eq(creditCardBillingCycles.source, "pluggy"),
      ),
    );
  const taken = new Set(
    (await trx
      .select({ statementMonth: creditCardBillingCycles.statementMonth })
      .from(creditCardBillingCycles)
      .where(eq(creditCardBillingCycles.creditCardId, card.id))).map((row) => row.statementMonth),
  );
  const moves = cycles
    .map((cycle) => ({
      ...cycle,
      target: `${statementMonthForDueDate(cycle.dueAt, closingDay, dueDay)}-01`,
    }))
    .filter((cycle) => cycle.target !== cycle.statementMonth);
  // Every cycle shifts by the same month, so walking in the direction of the
  // shift frees each target before it is needed.
  const forward = moves.some((move) => move.target > move.statementMonth);
  moves.sort((left, right) =>
    forward
      ? right.statementMonth.localeCompare(left.statementMonth)
      : left.statementMonth.localeCompare(right.statementMonth),
  );
  for (const move of moves) {
    // A month already held by a cycle the user recorded stays theirs.
    if (taken.has(move.target)) continue;
    await trx
      .update(creditCardBillingCycles)
      .set({ statementMonth: move.target })
      .where(eq(creditCardBillingCycles.id, move.id));
    taken.delete(move.statementMonth);
    taken.add(move.target);
  }

  // A projected parcel falls due with its statement. The bill due in a given
  // month is still due that month, only on the corrected day.
  if (dueDay !== card.defaultDueDay) {
    const projected = await trx
      .select({ id: installments.id, expectedAt: installments.expectedAt })
      .from(installments)
      .innerJoin(installmentPlans, eq(installmentPlans.id, installments.installmentPlanId))
      .innerJoin(
        creditCardPurchases,
        eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId),
      )
      .where(
        and(
          eq(creditCardPurchases.creditCardId, card.id),
          eq(installments.status, "projected"),
        ),
      );
    for (const parcel of projected) {
      await trx
        .update(installments)
        .set({ expectedAt: dayInMonth(parcel.expectedAt.slice(0, 7), dueDay) })
        .where(eq(installments.id, parcel.id));
    }
  }

  return { closingDay, dueDay, changed: true };
}

/** `2026-02` and 31 → `2026-02-28`. */
function dayInMonth(month: string, day: number): string {
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** Days apart on a month's clock face: the 30th and the 2nd are three apart. */
function dayDistance(left: number, right: number): number {
  const gap = Math.abs(left - right);
  return Math.min(gap, 31 - gap);
}

function observedDay(configured: number, observations: number[]): number {
  if (observations.length === 0) return configured;
  if (observations.some((day) => dayDistance(day, configured) <= 3)) return configured;
  const frequency = new Map<number, number>();
  for (const day of observations) frequency.set(day, (frequency.get(day) ?? 0) + 1);
  // Observations arrive newest first, so the first to reach the top count wins a tie.
  let best = observations[0]!;
  for (const day of observations) {
    if (frequency.get(day)! > frequency.get(best)!) best = day;
  }
  return best;
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

    // A closed bill with nothing owed is settled by definition. Calling it
    // overdue once its due date passed told the user they were in arrears on
    // a card they had not used.
    const status = bill.isPaid || (bill.closedAt && bill.totalMinor <= 0)
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

  // A parcel that already settled an installment has no purchase of its own,
  // so the check above cannot see it. Every sync re-reads a window of recent
  // days, and without this the second read of a joined parcel found its
  // installment no longer `projected`, failed to claim it, and opened a whole
  // new plan for the same goods — which is how one purchase became two or
  // three plans each projecting the remaining parcels (PRD R3).
  const alreadyBilled = await trx.query.installments.findFirst({
    where: eq(installments.transactionId, args.transactionId),
    columns: { id: true },
  });
  if (alreadyBilled) return { plansWritten: 0 };

  // A later parcel of a plan we already know about: mark it billed, do not
  // create a second purchase for the same goods.
  if (row.installment) {
    const joined = await joinExistingPlan(trx, {
      creditCardId: args.creditCardId,
      closingDay: args.closingDay,
      dueDay: args.dueDay,
      parcel: {
        transactionId: args.transactionId,
        date: row.date,
        amountMinor: totalAmountMinor,
        number: row.installment.number,
        total: row.installment.total,
      },
    });
    if (joined) return { plansWritten: 0 };
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

/** One parcel as the provider posted it: what matching a plan needs. */
interface ParcelFact {
  transactionId: string;
  /** Posting date of the parcel's charge. */
  date: string;
  /** Positive magnitude. */
  amountMinor: number;
  number: number;
  total: number;
}

interface StoredPlan {
  planId: string;
  purchaseId: string;
  purchaseDate: string;
  categoryId: string | null;
  totalInstallments: number;
  firstInstallmentNumber: number;
  parcels: {
    id: string;
    number: number;
    amountMinor: number;
    expectedAt: string;
    status: "projected" | "billed" | "paid" | "cancelled";
    transactionId: string | null;
  }[];
}

/**
 * The provider's rounding moves a parcel by a cent or two between the
 * projection and the charge (and between parcels of one purchase), so an exact
 * amount would miss the match it is meant to find. A real of slack is far
 * tighter than the gap between two genuinely different purchases.
 */
const PARCEL_ROUNDING_MINOR = 100;

function monthIndex(day: string): number {
  return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
}

/**
 * The month parcel 1 of a purchase falls due, as a month index.
 *
 * Every parcel of one purchase agrees on it — parcel 6 due in October and
 * parcel 2 due in June both point at parcel 1 in May — which is what lets a
 * parcel be recognised as part of a plan without a purchase id, whatever order
 * the parcels arrive in.
 */
function parcelOneDueMonth(dueAt: string, number: number): number {
  return monthIndex(dueAt) - (number - 1);
}

function planAnchor(plan: StoredPlan): number | null {
  const lowest = [...plan.parcels].sort((left, right) => left.number - right.number)[0];
  return lowest ? parcelOneDueMonth(lowest.expectedAt, lowest.number) : null;
}

/**
 * The amount one parcel of the plan costs. The last parcel absorbs the rounding
 * remainder, so it is the least representative and only used when alone.
 */
function planParcelAmount(plan: StoredPlan): number | null {
  const sorted = [...plan.parcels].sort((left, right) => left.number - right.number);
  const regular = sorted.filter((parcel) => parcel.number !== plan.totalInstallments);
  return (regular[0] ?? sorted[0])?.amountMinor ?? null;
}

async function loadCardPlans(
  trx: Trx,
  creditCardId: string,
  totalInstallments?: number,
): Promise<StoredPlan[]> {
  const rows = await trx
    .select({
      planId: installmentPlans.id,
      purchaseId: creditCardPurchases.id,
      purchaseDate: creditCardPurchases.purchaseDate,
      categoryId: creditCardPurchases.categoryId,
      totalInstallments: installmentPlans.totalInstallments,
      firstInstallmentNumber: installmentPlans.firstInstallmentNumber,
      parcelId: installments.id,
      number: installments.number,
      amountMinor: installments.amountMinor,
      expectedAt: installments.expectedAt,
      status: installments.status,
      transactionId: installments.transactionId,
    })
    .from(installmentPlans)
    .innerJoin(
      creditCardPurchases,
      eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId),
    )
    .innerJoin(installments, eq(installments.installmentPlanId, installmentPlans.id))
    .where(
      and(
        eq(creditCardPurchases.creditCardId, creditCardId),
        totalInstallments === undefined
          ? undefined
          : eq(installmentPlans.totalInstallments, totalInstallments),
      ),
    );

  const byPlan = new Map<string, StoredPlan>();
  for (const row of rows) {
    let plan = byPlan.get(row.planId);
    if (!plan) {
      plan = {
        planId: row.planId,
        purchaseId: row.purchaseId,
        purchaseDate: row.purchaseDate,
        categoryId: row.categoryId,
        totalInstallments: row.totalInstallments,
        firstInstallmentNumber: row.firstInstallmentNumber,
        parcels: [],
      };
      byPlan.set(row.planId, plan);
    }
    plan.parcels.push({
      id: row.parcelId,
      number: row.number,
      amountMinor: row.amountMinor,
      expectedAt: row.expectedAt,
      status: row.status,
      transactionId: row.transactionId,
    });
  }
  return [...byPlan.values()];
}

/**
 * Attach a parcel to the plan it belongs to, if one exists. Returns whether it
 * did.
 *
 * The provider gives no purchase id, so the plan a parcel belongs to has to be
 * recognised from the parcel itself. The first version matched on the plan's
 * total amount and the merchant name, and both fail on real data: the provider
 * rounds `totalAmount` differently on each parcel of the same purchase (240.87
 * against 240.83), and the merchant is frequently null. Every parcel then became
 * a plan of its own, so one twelve-month purchase projected a tail twelve times
 * over and the forecast counted the same money again and again (PRD R3).
 *
 * What is actually stable is the parcel: its term, the amount charged every
 * month, and the month its parcel 1 fell due. A plan on this card agreeing on
 * all three is the one this charge belongs to, and the charge then either
 * settles the projected installment waiting at its number, or — when it is an
 * earlier parcel than any the plan has seen, because the provider's window
 * reached further back this time — extends the plan backwards. Both arrival
 * orders end in one plan.
 *
 * The month may differ by one: a parcel posted after the closing day lands on
 * the next statement while its siblings did not. Never more, so two identical
 * purchases bought months apart stay two plans.
 */
async function joinExistingPlan(
  trx: Trx,
  args: { creditCardId: string; closingDay: number; dueDay: number; parcel: ParcelFact },
): Promise<boolean> {
  const { parcel } = args;
  const dueAt = nominalCycleFor(parcel.date, args.closingDay, args.dueDay).dueAt;
  const anchor = parcelOneDueMonth(dueAt, parcel.number);

  const candidates = (await loadCardPlans(trx, args.creditCardId, parcel.total))
    .map((plan) => {
      const planMonth = planAnchor(plan);
      const amount = planParcelAmount(plan);
      return {
        plan,
        monthGap: planMonth === null ? Infinity : Math.abs(planMonth - anchor),
        amountGap: amount === null ? Infinity : Math.abs(amount - parcel.amountMinor),
      };
    })
    .filter((entry) => entry.monthGap <= 1 && entry.amountGap <= PARCEL_ROUNDING_MINOR)
    .sort((left, right) => left.monthGap - right.monthGap || left.amountGap - right.amountGap);

  for (const { plan } of candidates) {
    const waiting = plan.parcels.find(
      (one) => one.number === parcel.number && one.status === "projected",
    );
    if (waiting) {
      await trx
        .update(installments)
        .set({ status: "billed", amountMinor: parcel.amountMinor, transactionId: parcel.transactionId })
        .where(eq(installments.id, waiting.id));
      return true;
    }
  }

  for (const { plan } of candidates) {
    if (parcel.number >= plan.firstInstallmentNumber) continue;
    if (plan.parcels.some((one) => one.number === parcel.number)) continue;
    await prependParcel(trx, plan, parcel, dueAt);
    return true;
  }

  return false;
}

/** Extend a plan backwards with an earlier parcel than any it has seen. */
async function prependParcel(
  trx: Trx,
  plan: StoredPlan,
  parcel: ParcelFact,
  dueAt: string,
): Promise<void> {
  await trx.insert(installments).values({
    installmentPlanId: plan.planId,
    number: parcel.number,
    amountMinor: parcel.amountMinor,
    expectedAt: dueAt,
    status: "billed",
    transactionId: parcel.transactionId,
  });
  await trx
    .update(installmentPlans)
    .set({ firstInstallmentNumber: parcel.number })
    .where(eq(installmentPlans.id, plan.planId));
  // The purchase happened no later than its earliest parcel.
  if (parcel.date < plan.purchaseDate) {
    await trx
      .update(creditCardPurchases)
      .set({ purchaseDate: parcel.date })
      .where(eq(creditCardPurchases.id, plan.purchaseId));
  }
  plan.parcels.push({
    id: "",
    number: parcel.number,
    amountMinor: parcel.amountMinor,
    expectedAt: dueAt,
    status: "billed",
    transactionId: parcel.transactionId,
  });
  plan.firstInstallmentNumber = parcel.number;
}

export interface InstallmentRepair {
  /** Duplicate plans folded into the plan they repeated. */
  plansMerged: number;
  /** Parcels whose booked charge was found and linked, turning them `billed`. */
  parcelsLinked: number;
  /** Provider cycles with nothing owed that were marked overdue. */
  zeroCyclesSettled: number;
}

/**
 * Heal the installment ledger of every card a user has.
 *
 * Before `registerSyncedPurchase` learned to recognise a parcel it had already
 * joined, each re-read of the sync window opened a fresh plan for it, so real
 * data carries one purchase as two or three plans, each projecting the
 * remaining parcels — future statements counted them two or three times over.
 * The cause is fixed; this removes what it left behind, and runs on every sync
 * so anything of the same shape that appears later heals the same way.
 *
 * Two plans are the same purchase when they agree on card, term and parcel
 * amount (within rounding), never disagree about a parcel (no number billed
 * by two different charges), and either share a charge — the signature of the
 * bug — or point at the same month for parcel 1. The plan seen first is kept;
 * every charge the others recorded is moved onto it as a billed parcel, and
 * the others, with their duplicated projected tails, are deleted. Ledger
 * transactions are never touched: the purchase row being deleted only points
 * at a parcel's transaction, which stays exactly as it was.
 *
 * Idempotent: a second run finds nothing to merge and nothing to link.
 */
export async function repairInstallmentPlans(
  trx: Trx,
  userId: string,
): Promise<InstallmentRepair> {
  const result: InstallmentRepair = { plansMerged: 0, parcelsLinked: 0, zeroCyclesSettled: 0 };
  const cards = await trx.query.creditCards.findMany({
    where: eq(creditCards.userId, userId),
    columns: { id: true, accountId: true, defaultClosingDay: true, defaultDueDay: true },
  });

  for (const card of cards) {
    result.plansMerged += await mergeDuplicatePlans(trx, card.id);
    result.parcelsLinked += await linkOrphanParcels(trx, card);
  }

  if (cards.length > 0) {
    // A cycle with nothing owed was stamped overdue by older syncs once its due
    // date passed. The provider stops re-sending old bills, so the next sync
    // cannot correct them on its own.
    const settled = await trx
      .update(creditCardBillingCycles)
      .set({ status: "paid" })
      .where(
        and(
          inArray(
            creditCardBillingCycles.creditCardId,
            cards.map((card) => card.id),
          ),
          eq(creditCardBillingCycles.source, "pluggy"),
          eq(creditCardBillingCycles.status, "overdue"),
          lte(creditCardBillingCycles.confirmedTotalMinor, 0),
        ),
      )
      .returning({ id: creditCardBillingCycles.id });
    result.zeroCyclesSettled = settled.length;
  }

  return result;
}

async function mergeDuplicatePlans(trx: Trx, creditCardId: string): Promise<number> {
  const plans = (await loadCardPlans(trx, creditCardId)).sort(
    (left, right) =>
      left.firstInstallmentNumber - right.firstInstallmentNumber ||
      left.purchaseDate.localeCompare(right.purchaseDate) ||
      left.planId.localeCompare(right.planId),
  );

  const keepers: StoredPlan[] = [];
  let merged = 0;
  for (const plan of plans) {
    const keeper = keepers.find((candidate) => isSamePurchase(candidate, plan));
    if (!keeper) {
      keepers.push(plan);
      continue;
    }
    await foldPlanInto(trx, keeper, plan);
    merged += 1;
  }
  return merged;
}

function isSamePurchase(keeper: StoredPlan, other: StoredPlan): boolean {
  if (keeper.totalInstallments !== other.totalInstallments) return false;
  const keeperAmount = planParcelAmount(keeper);
  const otherAmount = planParcelAmount(other);
  if (keeperAmount === null || otherAmount === null) return false;
  if (Math.abs(keeperAmount - otherAmount) > PARCEL_ROUNDING_MINOR) return false;

  const keeperByNumber = new Map(keeper.parcels.map((parcel) => [parcel.number, parcel]));
  const keeperNumberByTransaction = new Map(
    keeper.parcels
      .filter((parcel) => parcel.transactionId)
      .map((parcel) => [parcel.transactionId!, parcel.number]),
  );

  let sharesCharge = false;
  for (const parcel of other.parcels) {
    const mine = keeperByNumber.get(parcel.number);
    // Two different charges for the same parcel number are two purchases.
    if (mine?.transactionId && parcel.transactionId && mine.transactionId !== parcel.transactionId) {
      return false;
    }
    if (parcel.transactionId) {
      const keeperNumber = keeperNumberByTransaction.get(parcel.transactionId);
      if (keeperNumber !== undefined && keeperNumber !== parcel.number) return false;
      if (keeperNumber === parcel.number) sharesCharge = true;
    }
  }

  return sharesCharge || planAnchor(keeper) === planAnchor(other);
}

async function foldPlanInto(trx: Trx, keeper: StoredPlan, other: StoredPlan): Promise<void> {
  const keeperByNumber = new Map(keeper.parcels.map((parcel) => [parcel.number, parcel]));
  for (const parcel of other.parcels) {
    if (!parcel.transactionId || parcel.status === "projected" || parcel.status === "cancelled") {
      continue;
    }
    const mine = keeperByNumber.get(parcel.number);
    if (mine?.transactionId) continue;
    if (mine) {
      await trx
        .update(installments)
        .set({
          status: parcel.status,
          amountMinor: parcel.amountMinor,
          transactionId: parcel.transactionId,
        })
        .where(eq(installments.id, mine.id));
      mine.status = parcel.status;
      mine.amountMinor = parcel.amountMinor;
      mine.transactionId = parcel.transactionId;
    } else if (parcel.number < keeper.firstInstallmentNumber) {
      await prependParcel(
        trx,
        keeper,
        {
          transactionId: parcel.transactionId,
          date: other.purchaseDate,
          amountMinor: parcel.amountMinor,
          number: parcel.number,
          total: keeper.totalInstallments,
        },
        parcel.expectedAt,
      );
    }
  }

  if (!keeper.categoryId && other.categoryId) {
    await trx
      .update(creditCardPurchases)
      .set({ categoryId: other.categoryId })
      .where(eq(creditCardPurchases.id, keeper.purchaseId));
    keeper.categoryId = other.categoryId;
  }

  // The duplicate plan goes with its projected tail. Its purchase row existed
  // only to carry it — its transaction is a parcel now billed on the keeper —
  // so it goes too, unless it carries another plan of its own.
  await trx.delete(installmentPlans).where(eq(installmentPlans.id, other.planId));
  const [remaining] = await trx
    .select({ count: count() })
    .from(installmentPlans)
    .where(eq(installmentPlans.creditCardPurchaseId, other.purchaseId));
  if ((remaining?.count ?? 0) === 0) {
    await trx.delete(creditCardPurchases).where(eq(creditCardPurchases.id, other.purchaseId));
  }
}

/**
 * Link parcels whose charge is in the ledger but settled no installment.
 *
 * A charge the provider marked as parcel n/N, on this card, that neither opened
 * a plan nor billed one, is a parcel some earlier sync failed to join. It joins
 * by the same rule a fresh sync uses. It never opens a plan here: a charge with
 * no plan to join is left for the sync that owns it.
 */
async function linkOrphanParcels(
  trx: Trx,
  card: { id: string; accountId: string; defaultClosingDay: number; defaultDueDay: number },
): Promise<number> {
  const orphans = await trx
    .select({
      id: transactions.id,
      date: transactions.date,
      amountMinor: transactions.amountMinor,
      installment: transactionMetadata.value,
    })
    .from(transactions)
    .innerJoin(
      transactionMetadata,
      and(
        eq(transactionMetadata.transactionId, transactions.id),
        eq(transactionMetadata.key, "open_finance.installment"),
      ),
    )
    .where(
      and(
        eq(transactions.accountId, card.accountId),
        isNull(transactions.deletedAt),
        lt(transactions.amountMinor, 0),
        sql`not exists (select 1 from ${installments} where ${installments.transactionId} = ${transactions.id})`,
        sql`not exists (select 1 from ${creditCardPurchases} where ${creditCardPurchases.transactionId} = ${transactions.id})`,
      ),
    )
    .orderBy(asc(transactions.date));

  let linked = 0;
  for (const orphan of orphans) {
    const match = /^(\d+)\/(\d+)$/.exec(orphan.installment);
    if (!match) continue;
    const number = Number(match[1]);
    const total = Number(match[2]);
    if (number < 1 || number > total) continue;
    const joined = await joinExistingPlan(trx, {
      creditCardId: card.id,
      closingDay: card.defaultClosingDay,
      dueDay: card.defaultDueDay,
      parcel: {
        transactionId: orphan.id,
        date: orphan.date,
        amountMinor: Math.abs(orphan.amountMinor),
        number,
        total,
      },
    });
    if (joined) linked += 1;
  }
  return linked;
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
