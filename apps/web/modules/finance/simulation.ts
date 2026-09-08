import "server-only";
import { and, asc, eq, gte } from "drizzle-orm";
import { creditCardBillingCycles, creditCards, db, paymentOptions, purchaseItems } from "@kosh/db";
import { todayIso } from "@kosh/domain";
import { nominalCycleDueDates, nominalCycleFor, type ForecastEvent } from "@hermes-finance/forecast";
import {
  comparePaymentOptions,
  simulatePurchase,
  type PaymentComparison,
  type PaymentOption,
  type PurchaseSimulation,
  type SoftReserve,
} from "@hermes-finance/planning";
import {
  buildUserForecastDetailed,
  getHardReserveMinor,
  getSoftReserves,
  listCreditCards,
} from "./queries";

export type PaymentMethod = "pix" | "boleto" | "cash" | "credit_card" | "debit_card";

export interface PurchaseOptionInput {
  id: string;
  label?: string;
  method: PaymentMethod;
  /** Cash price of the purchase, in integer minor units. */
  amountMinor: number;
  cardId?: string | null;
  /** Number of installments; omit or 1 for a single payment. */
  installments?: number | null;
  /** Per-installment amount when the plan carries interest. Defaults to an even split. */
  installmentAmountMinor?: number | null;
  /** When the purchase happens; drives which billing cycle a card charge lands in. Defaults to today. */
  purchaseDate?: string | null;
  /**
   * Explicit first cash settlement date. When known — a stored payment option
   * already carries one — it is used verbatim instead of being re-derived from
   * the card's cycle, which would shift every installment by a month.
   */
  firstPaymentDate?: string | null;
}

/**
 * Cash settlement dates for one payment option.
 *
 * A card purchase does not leave the account when it is made: it leaves on the
 * statement due date of the cycle it lands in. Real billing cycles are used
 * whenever they have been observed, and only the tail beyond them falls back to
 * the card's nominal closing and due days.
 */
async function resolveSettlementDates(
  option: PurchaseOptionInput,
  purchaseDate: string,
  installmentCount: number,
): Promise<{ dates: string[]; cardId?: string }> {
  if (option.method !== "credit_card" || !option.cardId) {
    // PIX, boleto, cash and debit settle on the purchase date itself.
    return { dates: [option.firstPaymentDate ?? purchaseDate] };
  }

  const card = await db.query.creditCards.findFirst({ where: eq(creditCards.id, option.cardId) });
  if (!card) throw new Error(`credit card ${option.cardId} was not found`);

  if (option.firstPaymentDate) {
    return {
      dates: nominalCycleDueDates(option.firstPaymentDate, card.defaultClosingDay, card.defaultDueDay, installmentCount),
      cardId: card.id,
    };
  }

  const nominal = nominalCycleFor(purchaseDate, card.defaultClosingDay, card.defaultDueDay);
  const observed = await db.query.creditCardBillingCycles.findMany({
    where: and(
      eq(creditCardBillingCycles.creditCardId, card.id),
      gte(creditCardBillingCycles.dueAt, nominal.dueAt),
    ),
    orderBy: [asc(creditCardBillingCycles.dueAt)],
    limit: installmentCount,
  });

  const dates = observed.map((cycle) => cycle.dueAt);
  if (dates.length < installmentCount) {
    const fallback = nominalCycleDueDates(purchaseDate, card.defaultClosingDay, card.defaultDueDay, installmentCount);
    dates.push(...fallback.slice(dates.length));
  }
  return { dates: dates.slice(0, installmentCount), cardId: card.id };
}

/**
 * Turns a payment option into the cash events the engine consumes.
 *
 * Installments are split evenly and the last one absorbs the remainder, so the
 * settlements always sum to the total cost — no cent appears or disappears.
 */
export async function toEnginePaymentOption(
  userId: string,
  option: PurchaseOptionInput,
): Promise<PaymentOption> {
  const purchaseDate = option.purchaseDate ?? todayIso();
  const installmentCount = Math.max(1, option.installments ?? 1);
  const { dates, cardId } = await resolveSettlementDates(option, purchaseDate, installmentCount);

  const perInstallment =
    option.installmentAmountMinor ?? Math.floor(option.amountMinor / installmentCount);
  const totalCostMinor =
    option.installmentAmountMinor != null ? option.installmentAmountMinor * installmentCount : option.amountMinor;

  const cashEvents: ForecastEvent[] = dates.map((expectedAt, index) => ({
    id: `simulation:${option.id}:${index + 1}`,
    logicalKey: `simulation:${option.id}:${index + 1}`,
    expectedAt,
    amountMinor: -perInstallment,
    sourceType: "purchase_simulation",
    confidence: "CONFIRMED",
  }));
  // Settle the rounding remainder on the final installment.
  const projected = perInstallment * installmentCount;
  cashEvents.at(-1)!.amountMinor -= totalCostMinor - projected;

  let card: PaymentOption["card"];
  if (cardId) {
    const cards = await listCreditCards(userId);
    const match = cards.find((item) => item.id === cardId);
    if (match) {
      card = {
        cardId,
        label: match.name,
        creditLimitMinor: match.creditLimitMinor,
        committedMinor: match.committedMinor,
      };
    }
  }

  return {
    id: option.id,
    label: option.label ?? defaultLabel(option, installmentCount, perInstallment),
    totalCostMinor,
    installments: installmentCount,
    cashEvents,
    card,
  };
}

function defaultLabel(option: PurchaseOptionInput, installmentCount: number, perInstallment: number): string {
  if (installmentCount === 1) return `${option.method.toUpperCase()} ${option.amountMinor}`;
  return `${installmentCount}x ${perInstallment}`;
}

async function loadReserves(userId: string): Promise<{ hardReserveMinor: number; softReserves: SoftReserve[] }> {
  const [hardReserveMinor, soft] = await Promise.all([getHardReserveMinor(userId), getSoftReserves(userId)]);
  return {
    hardReserveMinor,
    softReserves: soft.map((reserve) => ({ id: reserve.id, name: reserve.name, amountMinor: reserve.amountMinor })),
  };
}

export interface SimulationContext {
  horizonDays?: number;
  /** Latest acceptable date for the option's final settlement. */
  maxLastPaymentDate?: string;
}

/**
 * Answers "what happens to my cash if I buy this?" for a single option.
 *
 * Every number comes from the deterministic engine; the model may narrate the
 * result but never produces one.
 */
export async function simulateUserPurchase(
  userId: string,
  option: PurchaseOptionInput,
  context: SimulationContext = {},
): Promise<PurchaseSimulation> {
  const horizonDays = context.horizonDays ?? 365;
  const { forecast } = await buildUserForecastDetailed(userId, horizonDays);
  const { hardReserveMinor, softReserves } = await loadReserves(userId);

  return simulatePurchase({
    hardReserveMinor,
    softReserves,
    maxLastPaymentDate: context.maxLastPaymentDate,
    forecastInput: {
      asOf: forecast.asOf,
      horizonEnd: forecast.horizonEnd,
      balances: [{ accountId: "consolidated", amountMinor: forecast.openingBalanceMinor, observedAt: forecast.asOf }],
      events: forecast.events,
    },
    option: await toEnginePaymentOption(userId, option),
  });
}

/**
 * Compares payment alternatives for the same purchase.
 *
 * All options are scored against one shared financial snapshot, which is what
 * makes the differences between them attributable to the options themselves.
 */
export async function compareUserPaymentOptions(
  userId: string,
  options: PurchaseOptionInput[],
  context: SimulationContext = {},
): Promise<PaymentComparison> {
  const horizonDays = context.horizonDays ?? 365;
  const { forecast } = await buildUserForecastDetailed(userId, horizonDays);
  const { hardReserveMinor, softReserves } = await loadReserves(userId);
  const engineOptions = await Promise.all(options.map((option) => toEnginePaymentOption(userId, option)));

  return comparePaymentOptions({
    hardReserveMinor,
    softReserves,
    maxLastPaymentDate: context.maxLastPaymentDate,
    forecastInput: {
      asOf: forecast.asOf,
      horizonEnd: forecast.horizonEnd,
      balances: [{ accountId: "consolidated", amountMinor: forecast.openingBalanceMinor, observedAt: forecast.asOf }],
      events: forecast.events,
    },
    options: engineOptions,
  });
}

/**
 * Compares the payment options stored against a planned purchase item, using the
 * item's own deadline as the hard date constraint.
 */
export async function compareStoredPaymentOptions(userId: string, purchaseItemId: string) {
  const item = await db.query.purchaseItems.findFirst({
    where: eq(purchaseItems.id, purchaseItemId),
    with: { purchasePlan: true, paymentOptions: true },
  });
  if (!item || item.purchasePlan.userId !== userId) return null;

  const stored = await db.query.paymentOptions.findMany({
    where: eq(paymentOptions.purchaseItemId, purchaseItemId),
    orderBy: [asc(paymentOptions.totalCostMinor)],
  });
  if (stored.length === 0) {
    return {
      item,
      comparison: { options: [], status: "INSUFFICIENT_DATA" as const, blockers: ["no payment option is registered for this item"] },
    };
  }

  const comparison = await compareUserPaymentOptions(
    userId,
    stored.map((option) => ({
      id: option.id,
      method: option.paymentMethod,
      amountMinor: option.cashPriceMinor ?? option.totalCostMinor,
      cardId: option.cardId,
      installments: option.installments,
      installmentAmountMinor: option.installmentAmountMinor,
      purchaseDate: item.earliestPurchaseDate,
      firstPaymentDate: option.firstPaymentDate,
    })),
    { maxLastPaymentDate: item.deadline ?? undefined },
  );

  return { item, comparison };
}
