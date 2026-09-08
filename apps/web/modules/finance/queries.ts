import "server-only";
import { and, asc, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import {
  accounts,
  bills,
  recurringTransactions,
  balanceSnapshots,
  creditCardBillingCycles,
  creditCards,
  db,
  financialReserves,
  installments,
  projectedEvents,
  purchasePlans,
  transactions,
} from "@kosh/db";
import { addDays, todayIso } from "@kosh/domain";
import { getUserSettings } from "@/modules/settings/queries";
import {
  buildForecast,
  projectRecurrences,
  projectStatements,
  nominalCycleFor,
  type BillingCycle,
  type Confidence,
  type CycleCharge,
  type Forecast,
  type ForecastEvent,
  type RecurrenceInterval,
  type RecurrenceRule,
} from "@hermes-finance/forecast";
import { calculateSafeToSpend } from "@hermes-finance/planning";

const CONFIDENCE: Record<string, Confidence> = {
  actual: "ACTUAL",
  confirmed: "CONFIRMED",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

/** Account types whose balance is spendable cash. */
const LIQUID_ACCOUNT_TYPES = ["asset", "cash", "wallet"] as const;

/**
 * A bank balance older than this is reported as stale. It never blocks a
 * calculation: the PRD requires informing, not refusing.
 */
export const STALE_AFTER_DAYS = 3;

export type BalanceSource = "snapshot" | "ledger";

export interface AccountPosition {
  id: string;
  name: string;
  balanceMinor: number;
  currencyCode: string;
  /** Date the balance was observed, or the ledger's own as-of date. */
  observedAt: string;
  source: BalanceSource;
  ageDays: number;
  isStale: boolean;
}

export interface FinancePosition {
  asOf: string;
  balanceMinor: number;
  accounts: AccountPosition[];
  /** Names of accounts whose balance is older than the staleness policy. */
  staleAccountNames: string[];
}

function daysBetween(from: string, to: string): number {
  const start = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const end = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((end - start) / 86_400_000);
}

async function loadLiquidAccounts(userId: string) {
  const rows = await db.query.accounts.findMany({
    where: and(eq(accounts.userId, userId), eq(accounts.isArchived, false)),
    orderBy: [asc(accounts.name)],
  });
  return rows.filter((account) => (LIQUID_ACCOUNT_TYPES as readonly string[]).includes(account.type));
}

/**
 * Most recent observed balance per account.
 *
 * A snapshot is an external observation of the real bank balance; the ledger
 * balance is derived from what has been recorded. The snapshot wins when one
 * exists, and either way the caller learns how old the number is.
 */
async function loadLatestSnapshots(userId: string, asOf: string) {
  const rows = await db.query.balanceSnapshots.findMany({
    where: and(eq(balanceSnapshots.userId, userId), lte(balanceSnapshots.observedAt, asOf)),
    orderBy: [desc(balanceSnapshots.observedAt)],
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.accountId)) latest.set(row.accountId, row);
  }
  return latest;
}

export async function getFinancePosition(userId: string): Promise<FinancePosition> {
  const asOf = todayIso();
  const liquid = await loadLiquidAccounts(userId);
  const snapshots = await loadLatestSnapshots(userId, asOf);

  const positions = liquid.map((account): AccountPosition => {
    const snapshot = snapshots.get(account.id);
    const observedAt = snapshot?.observedAt ?? account.openingBalanceDate ?? asOf;
    const ageDays = Math.max(0, daysBetween(observedAt, asOf));
    return {
      id: account.id,
      name: account.name,
      balanceMinor: snapshot?.amountMinor ?? account.currentBalanceMinor,
      currencyCode: account.currencyCode,
      observedAt,
      source: snapshot ? "snapshot" : "ledger",
      ageDays,
      isStale: snapshot ? ageDays > STALE_AFTER_DAYS : false,
    };
  });

  return {
    asOf,
    balanceMinor: positions.reduce((total, position) => total + position.balanceMinor, 0),
    accounts: positions,
    staleAccountNames: positions.filter((position) => position.isStale).map((position) => position.name),
  };
}

function toRecurrenceInterval(interval: string): RecurrenceInterval {
  // The Kosh enum is a strict subset of the engine's cadences.
  return interval as RecurrenceInterval;
}

export interface UserForecast {
  forecast: Forecast;
  labels: Map<string, string>;
  position: FinancePosition;
}

/**
 * Assembles every normalized input the pure engine needs and runs it.
 *
 * Card purchases are deliberately absent: a purchase is an economic expense
 * dated at purchase time, while the only cash movement it causes is the
 * statement settlement produced by `projectStatements`. Feeding both would
 * count the same money twice.
 */
export async function buildUserForecastDetailed(userId: string, horizonDays = 30): Promise<UserForecast> {
  const startedAt = performance.now();
  const asOf = todayIso();
  const horizonEnd = addDays(asOf, horizonDays);
  const settings = await getUserSettings(userId);
  const position = await getFinancePosition(userId);
  const range = { from: asOf, to: horizonEnd };
  const labels = new Map<string, string>();
  const events: ForecastEvent[] = [];

  // 1. Events already materialized with explicit provenance.
  const persisted = await db.query.projectedEvents.findMany({
    where: and(
      eq(projectedEvents.userId, userId),
      gte(projectedEvents.expectedAt, asOf),
      lte(projectedEvents.expectedAt, horizonEnd),
    ),
    orderBy: [asc(projectedEvents.expectedAt), asc(projectedEvents.id)],
  });
  for (const event of persisted) {
    labels.set(event.logicalKey, event.eventType);
    events.push({
      id: event.id,
      logicalKey: event.logicalKey,
      expectedAt: event.expectedAt,
      amountMinor: event.amountMinor,
      sourceType: event.sourceType,
      confidence: CONFIDENCE[event.confidence] ?? "LOW",
      resolvedByTransactionId: event.resolvedByTransactionId ?? undefined,
    });
  }

  // 2. Bills: a known amount on a known date.
  const activeBills = await db.query.bills.findMany({
    where: and(eq(bills.userId, userId), eq(bills.isActive, true), eq(bills.currencyCode, settings.currencyCode)),
  });
  const billRules: RecurrenceRule[] = activeBills.map((bill) => ({
    id: `bill:${bill.id}`,
    sourceType: "bill",
    amountMinor: -bill.expectedAmountMinor,
    interval: toRecurrenceInterval(bill.recurrence),
    startDate: bill.nextDueDate,
    confidence: "CONFIRMED",
  }));
  events.push(
    ...tagLabels(
      projectRecurrences(billRules, range),
      labels,
      activeBills.map((bill) => [`recurring:bill:${bill.id}`, bill.name]),
    ),
  );

  // 3. Recurring rules. Transfers between own accounts net to zero, so they
  //    never enter the consolidated cash trajectory.
  const recurring = await db.query.recurringTransactions.findMany({
    where: and(
      eq(recurringTransactions.userId, userId),
      eq(recurringTransactions.isActive, true),
      eq(recurringTransactions.currencyCode, settings.currencyCode),
      ne(recurringTransactions.type, "transfer"),
    ),
  });
  const recurringRules: RecurrenceRule[] = recurring.map((rule) => ({
    id: `rule:${rule.id}`,
    sourceType: "recurring_rule",
    amountMinor: rule.amountMinor,
    interval: toRecurrenceInterval(rule.interval),
    startDate: rule.nextRunDate,
    confidence: "HIGH",
  }));
  events.push(
    ...tagLabels(
      projectRecurrences(recurringRules, range),
      labels,
      recurring.map((rule) => [`recurring:rule:${rule.id}`, rule.name]),
    ),
  );

  // 4. Credit-card statements: one cash settlement per billing cycle.
  const cards = await db.query.creditCards.findMany({
    where: and(eq(creditCards.userId, userId), eq(creditCards.active, true)),
  });
  const cardById = new Map(cards.map((card) => [card.id, card]));
  if (cards.length > 0) {
    const cycles = await db.query.creditCardBillingCycles.findMany({
      where: and(
        inArray(creditCardBillingCycles.creditCardId, [...cardById.keys()]),
        gte(creditCardBillingCycles.dueAt, asOf),
        lte(creditCardBillingCycles.dueAt, horizonEnd),
      ),
      orderBy: [asc(creditCardBillingCycles.dueAt)],
    });
    // A settled cycle is a fact, not a projection: it leaves the active set.
    const openCycles = cycles.filter((cycle) => cycle.status !== "paid");
    const charges = await loadCycleCharges(openCycles.map((cycle) => cycle.id));
    const statementEvents = projectStatements(
      openCycles.map(
        (cycle): BillingCycle => ({
          id: cycle.id,
          creditCardId: cycle.creditCardId,
          statementMonth: cycle.statementMonth,
          dueAt: cycle.dueAt,
          confirmedTotalMinor: cycle.confirmedTotalMinor ?? undefined,
        }),
      ),
      charges,
      range,
    );
    for (const cycle of openCycles) {
      const card = cardById.get(cycle.creditCardId);
      if (card) labels.set(`statement:${cycle.creditCardId}:${cycle.statementMonth}`, `Fatura ${card.name}`);
    }
    events.push(...statementEvents);
  }

  // Each source already excludes what has settled: a persisted event carries
  // its own `resolvedByTransactionId`, a paid billing cycle is filtered out
  // above, and Kosh rolls a bill's `nextDueDate` forward once it is paid. So
  // there is no separate fact list to reconcile against here; matching a
  // *derived* projection to an arbitrary transaction is reconciliation proper
  // (PRD §29), which needs a preview-and-confirm flow rather than a silent join.
  const forecast = buildForecast({
    asOf,
    horizonEnd,
    balances: position.accounts.map((account) => ({
      accountId: account.id,
      // Snapshots are normalized to the as-of date; freshness is reported
      // separately on the position rather than by shifting the date.
      amountMinor: account.balanceMinor,
      observedAt: asOf,
    })),
    events,
  });

  // Observability without disclosure: timing, volume and staleness only. No
  // amount, account name or identifier ever reaches the log.
  console.info(
    "[hermes forecast]",
    `horizon=${horizonDays}d`,
    `events=${forecast.events.length}`,
    `stale_accounts=${position.staleAccountNames.length}`,
    `ms=${Math.round(performance.now() - startedAt)}`,
  );

  return { forecast, labels, position };
}

function tagLabels(
  events: ForecastEvent[],
  labels: Map<string, string>,
  entries: Array<[string, string]>,
): ForecastEvent[] {
  const byPrefix = new Map(entries);
  for (const event of events) {
    const prefix = event.logicalKey.slice(0, event.logicalKey.lastIndexOf(":"));
    const label = byPrefix.get(prefix);
    if (label) labels.set(event.logicalKey, label);
  }
  return events;
}

async function loadCycleCharges(cycleIds: string[]): Promise<CycleCharge[]> {
  if (cycleIds.length === 0) return [];
  const rows = await db.query.installments.findMany({
    where: and(
      inArray(installments.billingCycleId, cycleIds),
      inArray(installments.status, ["projected", "billed"]),
    ),
  });
  return rows
    .filter((row) => row.billingCycleId !== null)
    .map((row) => ({ billingCycleId: row.billingCycleId!, amountMinor: row.amountMinor }));
}

/** Backwards-compatible entry point returning only the forecast. */
export async function buildUserForecast(userId: string, horizonDays = 30): Promise<Forecast> {
  const { forecast } = await buildUserForecastDetailed(userId, horizonDays);
  return forecast;
}

export async function getHardReserveMinor(userId: string): Promise<number> {
  const reserves = await db.query.financialReserves.findMany({
    where: and(
      eq(financialReserves.userId, userId),
      eq(financialReserves.kind, "hard"),
      eq(financialReserves.isActive, true),
    ),
  });
  return reserves.reduce((total, reserve) => total + reserve.amountMinor, 0);
}

export async function getSoftReserves(userId: string) {
  return db.query.financialReserves.findMany({
    where: and(
      eq(financialReserves.userId, userId),
      eq(financialReserves.kind, "soft"),
      eq(financialReserves.isActive, true),
    ),
    orderBy: [asc(financialReserves.name)],
  });
}

function safeToSpendFrom(forecast: Forecast, hardReserveMinor: number, position: FinancePosition) {
  const result = calculateSafeToSpend({
    hardReserveMinor,
    forecastInput: {
      asOf: forecast.asOf,
      horizonEnd: forecast.horizonEnd,
      balances: [{ accountId: "consolidated", amountMinor: forecast.openingBalanceMinor, observedAt: forecast.asOf }],
      events: forecast.events,
    },
  });
  return {
    ...result,
    hardReserveMinor,
    committedMinor: forecast.events
      .filter((event) => event.amountMinor < 0)
      .reduce((total, event) => total + -event.amountMinor, 0),
    staleAccountNames: position.staleAccountNames,
  };
}

export async function getSafeToSpend(userId: string, horizonDays = 30) {
  const { forecast, position } = await buildUserForecastDetailed(userId, horizonDays);
  return safeToSpendFrom(forecast, await getHardReserveMinor(userId), position);
}

/**
 * Safe-to-spend up to the next expected income, which is the horizon the user
 * actually thinks in ("how much can I spend until I get paid?").
 *
 * The whole answer comes from one forecast run: re-projecting over a shorter
 * horizon would re-read the database to reach the same trough.
 */
export async function getSafeToSpendUntilNextIncome(userId: string, maxHorizonDays = 90) {
  const { forecast, position } = await buildUserForecastDetailed(userId, maxHorizonDays);
  const nextIncome = forecast.events.find((event) => event.amountMinor > 0);
  if (!nextIncome) return null;

  const truncated: Forecast = {
    ...forecast,
    horizonEnd: nextIncome.expectedAt,
    days: forecast.days.filter((day) => day.date <= nextIncome.expectedAt),
    events: forecast.events.filter((event) => event.expectedAt <= nextIncome.expectedAt),
  };
  return {
    nextIncomeDate: nextIncome.expectedAt,
    ...safeToSpendFrom(truncated, await getHardReserveMinor(userId), position),
  };
}

export interface UpcomingCommitment {
  logicalKey: string;
  label: string;
  expectedAt: string;
  amountMinor: number;
  sourceType: string;
  confidence: Confidence;
}

/**
 * The unpaid commitments ahead, straight from the active forecast set, so a
 * projection already settled by a real transaction never shows up here.
 */
export async function getUpcomingCommitments(userId: string, horizonDays = 30): Promise<UpcomingCommitment[]> {
  const { forecast, labels } = await buildUserForecastDetailed(userId, horizonDays);
  return forecast.events
    .filter((event) => event.amountMinor < 0)
    .map((event) => ({
      logicalKey: event.logicalKey,
      label: labels.get(event.logicalKey) ?? event.sourceType,
      expectedAt: event.expectedAt,
      amountMinor: event.amountMinor,
      sourceType: event.sourceType,
      confidence: event.confidence,
    }));
}

export interface ConfidenceBreakdown {
  totalMinor: number;
  byConfidence: Record<Confidence, number>;
  /** Share of the projected volume per confidence level, 0-100, rounded. */
  sharePercent: Record<Confidence, number>;
}

/** How much of the projection rests on facts versus assumptions (PRD §61). */
export async function getConfidenceBreakdown(userId: string, horizonDays = 30): Promise<ConfidenceBreakdown> {
  const { forecast } = await buildUserForecastDetailed(userId, horizonDays);
  const byConfidence: Record<Confidence, number> = { ACTUAL: 0, CONFIRMED: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const event of forecast.events) {
    byConfidence[event.confidence] += Math.abs(event.amountMinor);
  }
  const totalMinor = Object.values(byConfidence).reduce((total, value) => total + value, 0);
  const sharePercent = { ACTUAL: 0, CONFIRMED: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<Confidence, number>;
  if (totalMinor > 0) {
    for (const key of Object.keys(byConfidence) as Confidence[]) {
      sharePercent[key] = Math.round((byConfidence[key] / totalMinor) * 100);
    }
  }
  return { totalMinor, byConfidence, sharePercent };
}

/**
 * Cards with how much of the limit is actually taken.
 *
 * The committed amount comes from the linked ledger account's outstanding
 * balance, not from the installment table. Every `creditCardPurchase` points at
 * a real transaction, so the account balance already carries the full debt —
 * including purchases that will be billed over future statements. Adding
 * installments on top of it would count the same money twice, and deriving it
 * from installments alone (as this used to) reports zero for any card whose
 * history came from an import, overstating the available limit.
 */
export async function listCreditCards(userId: string) {
  const cards = await db.query.creditCards.findMany({
    where: and(eq(creditCards.userId, userId), eq(creditCards.active, true)),
    orderBy: [asc(creditCards.name)],
    with: { account: true },
  });
  if (cards.length === 0) return [];

  // Scoped to this user's cards: a tenant must never read another's schedule.
  const cardIds = cards.map((card) => card.id);
  const scheduled = await db.query.installments.findMany({
    where: and(gte(installments.expectedAt, todayIso()), inArray(installments.status, ["projected", "billed"])),
    with: { installmentPlan: { with: { creditCardPurchase: true } } },
  });
  const scheduledByCard = new Map<string, number>();
  for (const item of scheduled) {
    const cardId = item.installmentPlan.creditCardPurchase.creditCardId;
    if (!cardIds.includes(cardId)) continue;
    scheduledByCard.set(cardId, (scheduledByCard.get(cardId) ?? 0) + item.amountMinor);
  }

  return cards.map((card) => {
    // A card account holds a negative balance while money is owed.
    const committedMinor = Math.max(0, -(card.account?.currentBalanceMinor ?? 0));
    return {
      ...card,
      committedMinor,
      /** Of the committed total, how much is already scheduled as installments. */
      scheduledInstallmentsMinor: scheduledByCard.get(card.id) ?? 0,
      availableLimitMinor: card.creditLimitMinor - committedMinor,
      utilizationPercent:
        card.creditLimitMinor > 0 ? Math.round((committedMinor / card.creditLimitMinor) * 100) : 0,
    };
  });
}

export type CycleSource = "recorded" | "derived";

export interface CardStatementCycle {
  id: string;
  statementMonth: string;
  closesAt: string;
  dueAt: string;
  /** Purchases and fees posted in the period, as a positive magnitude. */
  chargesMinor: number;
  /** Payments and refunds posted in the period, as a positive magnitude. */
  creditsMinor: number;
  /** Reconciled statement total when known, otherwise net movement. */
  totalMinor: number;
  isReconciled: boolean;
  source: CycleSource;
  status: string;
}

/**
 * Statement history for a card.
 *
 * Recorded `CreditCardBillingCycle` rows are the truth when they exist, but a
 * card imported from a bank export has none — only ledger transactions. Rather
 * than showing an empty page for a card with a year of spending, the remaining
 * periods are derived from the card's closing and due days, and labelled as
 * derived so a reconciled statement is never confused with an inferred one.
 */
export async function getCardStatement(userId: string, cardId: string) {
  const card = await db.query.creditCards.findFirst({
    where: and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)),
  });
  if (!card) return null;

  const recorded = await db.query.creditCardBillingCycles.findMany({
    where: eq(creditCardBillingCycles.creditCardId, cardId),
    with: { installments: true },
  });

  const ledger = await db.query.transactions.findMany({
    where: and(eq(transactions.userId, userId), eq(transactions.accountId, card.accountId)),
    columns: { date: true, amountMinor: true },
  });

  const byMonth = new Map<string, CardStatementCycle>();

  for (const entry of ledger) {
    const cycle = nominalCycleFor(entry.date, card.defaultClosingDay, card.defaultDueDay);
    const existing = byMonth.get(cycle.statementMonth) ?? {
      id: `derived:${cardId}:${cycle.statementMonth}`,
      statementMonth: cycle.statementMonth,
      closesAt: cycle.closesAt,
      dueAt: cycle.dueAt,
      chargesMinor: 0,
      creditsMinor: 0,
      totalMinor: 0,
      isReconciled: false,
      source: "derived" as const,
      status: "closed",
    };
    if (entry.amountMinor < 0) existing.chargesMinor += -entry.amountMinor;
    else existing.creditsMinor += entry.amountMinor;
    existing.totalMinor = existing.chargesMinor - existing.creditsMinor;
    byMonth.set(cycle.statementMonth, existing);
  }

  // A recorded cycle always wins over the derived one for the same month.
  for (const cycle of recorded) {
    const month = cycle.statementMonth.slice(0, 7);
    const chargedMinor = cycle.installments
      .filter((item) => item.status !== "cancelled")
      .reduce((total, item) => total + item.amountMinor, 0);
    byMonth.set(month, {
      id: cycle.id,
      statementMonth: month,
      closesAt: cycle.closedAt ?? cycle.openedAt,
      dueAt: cycle.dueAt,
      chargesMinor: chargedMinor,
      creditsMinor: 0,
      totalMinor: cycle.confirmedTotalMinor ?? chargedMinor,
      isReconciled: cycle.confirmedTotalMinor !== null,
      source: "recorded",
      status: cycle.status,
    });
  }

  const cycles = [...byMonth.values()].sort((left, right) =>
    right.statementMonth.localeCompare(left.statementMonth),
  );

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
    with: { items: { with: { paymentOptions: true, simulations: true } } },
  });
}
