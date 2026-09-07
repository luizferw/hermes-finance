import "server-only";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  creditCardBillingCycles,
  creditCards,
  db,
  financialReserves,
  installments,
  paymentOptions,
  projectedEvents,
  purchaseItems,
  purchasePlans,
} from "@kosh/db";
import { addDays, todayIso } from "@kosh/domain";
import { buildForecast, type ForecastEvent } from "@hermes-finance/forecast";
import { calculateSafeToSpend } from "@hermes-finance/planning";

const CONFIDENCE = { actual: "ACTUAL", confirmed: "CONFIRMED", high: "HIGH", medium: "MEDIUM", low: "LOW" } as const;

export async function getFinancePosition(userId: string) {
  const rows = await db.query.accounts.findMany({
    where: and(eq(accounts.userId, userId), eq(accounts.isArchived, false)),
    orderBy: [asc(accounts.name)],
  });
  const liquid = rows.filter((a) => a.type === "asset" || a.type === "cash" || a.type === "wallet");
  const balanceMinor = liquid.reduce((sum, a) => sum + a.currentBalanceMinor, 0);
  const latest = await db.query.balanceSnapshots.findMany({
    where: eq(balanceSnapshots.userId, userId),
    orderBy: [asc(balanceSnapshots.observedAt)],
  });
  const observedByAccount = new Map(latest.map((s) => [s.accountId, s.observedAt]));
  return {
    balanceMinor,
    accounts: liquid.map((a) => ({ id: a.id, name: a.name, balanceMinor: a.currentBalanceMinor, currencyCode: a.currencyCode, observedAt: observedByAccount.get(a.id) ?? a.openingBalanceDate })),
  };
}

export async function buildUserForecast(userId: string, horizonDays = 30) {
  const asOf = todayIso();
  const horizonEnd = addDays(asOf, horizonDays);
  const position = await getFinancePosition(userId);
  const activeAccounts = position.accounts;
  const rows = await db.query.projectedEvents.findMany({
    where: and(eq(projectedEvents.userId, userId), gte(projectedEvents.expectedAt, asOf), lte(projectedEvents.expectedAt, horizonEnd)),
    orderBy: [asc(projectedEvents.expectedAt), asc(projectedEvents.id)],
  });
  const events: ForecastEvent[] = rows.map((event) => ({
    id: event.id,
    logicalKey: event.logicalKey,
    expectedAt: event.expectedAt,
    amountMinor: event.amountMinor,
    sourceType: event.sourceType,
    confidence: CONFIDENCE[event.confidence],
    resolvedByTransactionId: event.resolvedByTransactionId ?? undefined,
  }));
  return buildForecast({
    asOf,
    horizonEnd,
    balances: activeAccounts.map((a) => ({ accountId: a.id, amountMinor: a.balanceMinor, observedAt: asOf })),
    events,
  });
}

export async function getSafeToSpend(userId: string, horizonDays = 30) {
  const forecast = await buildUserForecast(userId, horizonDays);
  const reserves = await db.query.financialReserves.findMany({
    where: and(eq(financialReserves.userId, userId), eq(financialReserves.kind, "hard"), eq(financialReserves.isActive, true)),
  });
  const hardReserveMinor = reserves.reduce((sum, reserve) => sum + reserve.amountMinor, 0);
  return calculateSafeToSpend({
    hardReserveMinor,
    forecastInput: {
      asOf: forecast.asOf,
      horizonEnd: forecast.horizonEnd,
      balances: [{ accountId: "consolidated", amountMinor: forecast.openingBalanceMinor, observedAt: forecast.asOf }],
      events: forecast.events,
    },
  });
}

export async function listCreditCards(userId: string) {
  const cards = await db.query.creditCards.findMany({ where: and(eq(creditCards.userId, userId), eq(creditCards.active, true)), orderBy: [asc(creditCards.name)] });
  return Promise.all(cards.map(async (card) => {
    const futureInstallments = await db.query.installments.findMany({
      where: and(gte(installments.expectedAt, todayIso()), inArray(installments.status, ["projected", "billed"])),
      with: { installmentPlan: { with: { creditCardPurchase: true } } },
    });
    const cardInstallments = futureInstallments.filter((item) => item.installmentPlan.creditCardPurchase.creditCardId === card.id);
    const committedMinor = cardInstallments.reduce((sum, item) => sum + item.amountMinor, 0);
    return { ...card, committedMinor, availableLimitMinor: card.creditLimitMinor - committedMinor };
  }));
}

export async function getCardStatement(userId: string, cardId: string) {
  const card = await db.query.creditCards.findFirst({ where: and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)) });
  if (!card) return null;
  const cycles = await db.query.creditCardBillingCycles.findMany({ where: eq(creditCardBillingCycles.creditCardId, cardId), orderBy: [asc(creditCardBillingCycles.dueAt)] });
  return { card, cycles };
}

export async function listPurchasePlans(userId: string) {
  return db.query.purchasePlans.findMany({
    where: eq(purchasePlans.userId, userId),
    with: { items: { with: { paymentOptions: true } } },
    orderBy: [asc(purchasePlans.targetDate)],
  });
}

export async function getPurchasePlan(userId: string, id: string) {
  return db.query.purchasePlans.findFirst({
    where: and(eq(purchasePlans.id, id), eq(purchasePlans.userId, userId)),
    with: { items: { with: { paymentOptions: true } } },
  });
}
