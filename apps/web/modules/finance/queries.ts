import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import {
  accounts,
  bills,
  recurringTransactions,
  balanceSnapshots,
  creditCardBillingCycles,
  creditCardPurchases,
  creditCards,
  db,
  financialReserves,
  installmentPlans,
  installments,
  projectedEvents,
  purchaseItems,
  purchasePlans,
  transactions,
} from "@kosh/db";
import { addDays, monthRange, todayIso } from "@kosh/domain";
import { getUserSettings } from "@/modules/settings/queries";
import {
  allocateCardDebt,
  BUDGET_ESTIMATE_SOURCE,
  buildForecast,
  projectRecurrences,
  projectStatements,
  nominalCycleFor,
  statementMonthForDueDate,
  type BillingCycle,
  type BudgetConsumptionBlocker,
  type BudgetMonthEstimate,
  type Confidence,
  type ConsumptionCommitment,
  type CycleCharge,
  type Forecast,
  type ForecastEvent,
  type RecurrenceInterval,
  type RecurrenceRule,
  type VariableSpendingScenario,
} from "@hermes-finance/forecast";
import {
  calculateSafeToSpend,
  calculateSpendingRoom,
  debtPaymentsFromForecast,
  simulatePurchasePlan,
  type CardActivity,
  type PlanItemOption,
  type PurchasePlanSimulation,
} from "@hermes-finance/planning";
import { loadBudgetConsumption, type BudgetConsumption } from "./budget-consumption";
import { loadCardContext, toEnginePaymentOption } from "./simulation";

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

/**
 * Staleness is a property of the source, not of the number (PRD §62).
 *
 * A hand-entered balance three days old is ordinary; a provider balance two
 * days old is a symptom, because Open Finance refreshes daily on the provider's
 * side and an older reading means the connection stopped working.
 */
const STALE_AFTER_DAYS_BY_SOURCE: Record<string, number> = { pluggy: 2 };

function staleAfterDays(sourceName: string): number {
  return STALE_AFTER_DAYS_BY_SOURCE[sourceName] ?? STALE_AFTER_DAYS;
}

export type BalanceSource = "snapshot" | "ledger";

export interface AccountPosition {
  id: string;
  name: string;
  balanceMinor: number;
  currencyCode: string;
  /** Date the balance was observed, or the ledger's own as-of date. */
  observedAt: string;
  source: BalanceSource;
  /** Who produced the observation: "manual", "pluggy", or "ledger" when derived. */
  sourceName: string;
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
    const sourceName = snapshot?.source ?? "ledger";
    return {
      id: account.id,
      name: account.name,
      balanceMinor: snapshot?.amountMinor ?? account.currentBalanceMinor,
      currencyCode: account.currencyCode,
      observedAt,
      source: snapshot ? "snapshot" : "ledger",
      sourceName,
      ageDays,
      isStale: snapshot ? ageDays > staleAfterDays(sourceName) : false,
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

/**
 * Card balance that did not fit on any statement still ahead, and so is absent
 * from the horizon.
 *
 * Usually not a gap: a provider reports a card's balance as everything
 * outstanding, future installments included, and those are already projected
 * onto the statements that will bill them. On a card genuinely in arrears it is
 * a real understatement. Either way it is surfaced rather than dropped in
 * silence — see `allocateCardDebt`.
 */
export interface CardDebtUnplaced {
  cardId: string;
  cardName: string;
  /** How much of the balance found no statement, as a positive magnitude. */
  unplacedMinor: number;
  /**
   * Projected parcels of this card falling due from today on, at any date —
   * the part of the balance the forecast does bill, parcel by parcel, on the
   * statements that will charge them.
   */
  futureInstallmentsMinor: number;
  /**
   * `unplacedMinor − futureInstallmentsMinor`, never below zero: balance that
   * neither a statement ahead nor a known future parcel accounts for. Zero on
   * a card whose provider simply counts future parcels in its balance; above
   * zero it is arrears, interest or a purchase the system never saw, and the
   * forecast's statements understate the card by about this much.
   */
  unexplainedMinor: number;
}

/** One charge making up a projected statement, as the forecast counted it. */
export type StatementComponent =
  | {
      /** The card's ledger debt allocated to this derived statement (`allocateCardDebt`). */
      kind: "posted_charges";
      amountMinor: number;
    }
  | {
      kind: "installment";
      amountMinor: number;
      purchaseId: string;
      description: string;
      number: number;
      totalInstallments: number;
      status: "projected" | "billed" | "paid" | "cancelled";
    }
  | {
      /** A bill charged to the card, on the statement open the day it posts. */
      kind: "card_bill";
      amountMinor: number;
      billId: string;
      name: string;
      chargedAt: string;
    };

/**
 * A card statement the forecast settles inside the horizon, taken apart.
 *
 * `amountMinor` is exactly the cash event's magnitude: the confirmed total when
 * the cycle has one (`confirmedTotalMinor`, which then wins over its parts),
 * otherwise `componentsTotalMinor`.
 */
export interface ProjectedCardStatement {
  cardId: string;
  cardName: string;
  /** `YYYY-MM`. */
  statementMonth: string;
  dueAt: string;
  logicalKey: string;
  eventId: string;
  /**
   * recorded / open_finance: a stored cycle; derived: inferred from the card's
   * ledger; synthesized: a month with no cycle yet, opened only because a card
   * bill or a projected parcel falls due in it.
   */
  cycleSource: "recorded" | "open_finance" | "derived" | "synthesized";
  amountMinor: number;
  confidence: Confidence;
  confirmedTotalMinor: number | null;
  componentsTotalMinor: number;
  components: StatementComponent[];
}

export interface UserForecast {
  forecast: Forecast;
  labels: Map<string, string>;
  position: FinancePosition;
  /** Empty whenever every card's balance fits on statements still ahead. */
  cardDebtUnplaced: CardDebtUnplaced[];
  /** Every statement settlement in the horizon, with what it is made of. */
  cardStatements: ProjectedCardStatement[];
  /** Which variable-spending estimate `forecast` carries. */
  scenario: VariableSpendingScenario;
  /** Every projected commitment, before any budget estimate joins them. */
  commitmentEvents: ForecastEvent[];
  /** What each budget still allows, and the estimate events it became. */
  budgetConsumption: BudgetConsumption;
}

/**
 * User-facing numbers set aside what the budgets still allow; `none` is kept
 * for showing what that reservation costs.
 */
export const DEFAULT_VARIABLE_SPENDING: VariableSpendingScenario = "budget";

/**
 * The same forecast under another variable-spending scenario, without reading
 * the database again: the commitments are identical, only the estimate changes.
 */
export function forecastForScenario(detailed: UserForecast, scenario: VariableSpendingScenario): Forecast {
  if (scenario === detailed.scenario) return detailed.forecast;
  const { forecast } = detailed;
  return buildForecast({
    asOf: forecast.asOf,
    horizonEnd: forecast.horizonEnd,
    balances: [{ accountId: "consolidated", amountMinor: forecast.openingBalanceMinor, observedAt: forecast.asOf }],
    events: [
      ...detailed.commitmentEvents,
      ...(scenario === "none" ? [] : detailed.budgetConsumption.events),
    ],
  });
}

/**
 * What the forecast already expects on the cards: each statement it settles,
 * and — when it carries the budget estimate — the card share of that spending,
 * charged on the day it is spent.
 */
export function cardActivityFor(detailed: UserForecast): CardActivity {
  return {
    debtPayments: debtPaymentsFromForecast(detailed.commitmentEvents),
    charges: detailed.scenario === "none" ? [] : detailed.budgetConsumption.cardCharges,
  };
}

/**
 * Assembles every normalized input the pure engine needs and runs it.
 *
 * Card purchases are deliberately absent: a purchase is an economic expense
 * dated at purchase time, while the only cash movement it causes is the
 * statement settlement produced by `projectStatements`. Feeding both would
 * count the same money twice.
 */
export async function buildUserForecastDetailed(
  userId: string,
  horizonDays = 30,
  options: { variableSpending?: VariableSpendingScenario } = {},
): Promise<UserForecast> {
  const startedAt = performance.now();
  const scenario = options.variableSpending ?? DEFAULT_VARIABLE_SPENDING;
  const asOf = todayIso();
  const horizonEnd = addDays(asOf, horizonDays);
  // A budget's remaining amount is a whole-month figure, so what is already
  // committed in its categories has to be known to the end of the last month
  // the horizon touches, even past the horizon itself.
  const commitmentsEnd = monthRange(horizonEnd).end;
  const commitmentRange = { from: asOf, to: commitmentsEnd };
  const commitments: ConsumptionCommitment[] = [];
  const settings = await getUserSettings(userId);
  const position = await getFinancePosition(userId);
  const range = { from: asOf, to: horizonEnd };
  const labels = new Map<string, string>();
  const events: ForecastEvent[] = [];
  const cardDebtUnplaced: CardDebtUnplaced[] = [];
  const cardStatements: ProjectedCardStatement[] = [];

  // 1. Events already materialized with explicit provenance.
  const persisted = await db.query.projectedEvents.findMany({
    where: and(
      eq(projectedEvents.userId, userId),
      gte(projectedEvents.expectedAt, asOf),
      lte(projectedEvents.expectedAt, commitmentsEnd),
    ),
    orderBy: [asc(projectedEvents.expectedAt), asc(projectedEvents.id)],
  });
  for (const event of persisted) {
    if (event.categoryId && event.amountMinor < 0 && !event.resolvedByTransactionId) {
      commitments.push({
        categoryId: event.categoryId,
        date: event.expectedAt,
        amountMinor: -event.amountMinor,
        source: { kind: "projected_event", id: event.id, label: event.eventType },
      });
    }
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

  // The cards are needed here, before the bills, to tell a bill paid out of a
  // bank account from one charged to a card — the two settle on different
  // dates, out of different pockets.
  const cards = await db.query.creditCards.findMany({
    where: and(eq(creditCards.userId, userId), eq(creditCards.active, true)),
  });
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const cardByAccountId = new Map(cards.map((card) => [card.accountId, card]));

  // 2. Bills: a fixed one always projects at its typed amount. A variable
  // one (PRD §9.10) prefers the amount of whichever transaction last actually
  // paid it — real history beats a manually typed guess — and only falls
  // back to the typed estimate until that history exists.
  const activeBills = await db.query.bills.findMany({
    where: and(eq(bills.userId, userId), eq(bills.isActive, true), eq(bills.currencyCode, settings.currencyCode)),
  });
  const variableBillIds = activeBills.filter((bill) => bill.amountStrategy === "variable").map((bill) => bill.id);
  const lastPaidMinorByBill = new Map<string, number>();
  if (variableBillIds.length > 0) {
    const paidTransactions = await db.query.transactions.findMany({
      where: inArray(transactions.billId, variableBillIds),
      orderBy: [desc(transactions.date)],
      columns: { billId: true, amountMinor: true },
    });
    for (const paid of paidTransactions) {
      // Rows arrive most-recent-first; keep only each bill's first (latest) hit.
      if (paid.billId && !lastPaidMinorByBill.has(paid.billId)) {
        lastPaidMinorByBill.set(paid.billId, Math.abs(paid.amountMinor));
      }
    }
  }
  const ruleForBill = (bill: (typeof activeBills)[number]): RecurrenceRule => {
    const lastPaidMinor = lastPaidMinorByBill.get(bill.id);
    const amountMinor = lastPaidMinor ?? bill.expectedAmountMinor;
    // A fixed bill is HIGH — the same provenance as the sibling
    // recurring_transactions source below (typed, never a confirmed fact).
    // A variable one backed by real payment history is MEDIUM — better than a
    // guess, still a projection for a future date. With no history yet it is
    // LOW: an unverified manual figure for an account known to fluctuate.
    const confidence: Confidence =
      bill.amountStrategy === "fixed" ? "HIGH" : lastPaidMinor !== undefined ? "MEDIUM" : "LOW";
    return {
      id: `bill:${bill.id}`,
      sourceType: "bill",
      amountMinor: -amountMinor,
      interval: toRecurrenceInterval(bill.recurrence),
      startDate: bill.nextDueDate,
      confidence,
    };
  };

  // A bill charged to a credit card is not a cash event on its due date
  // (PRD R4): the card pays it, and the money only leaves the bank when that
  // card's statement settles. Projecting it here would take the cash weeks
  // early and out of the wrong pocket, so these bills are held back and folded
  // into their billing cycle in step 4 instead.
  // Every bill is incurred on its due date wherever it is paid from, so for a
  // budget a card bill counts in the month it is charged, not when it settles.
  for (const bill of activeBills) {
    if (!bill.categoryId) continue;
    for (const occurrence of projectRecurrences([ruleForBill(bill)], commitmentRange)) {
      commitments.push({
        categoryId: bill.categoryId,
        date: occurrence.expectedAt,
        amountMinor: -occurrence.amountMinor,
        source: { kind: "bill", id: bill.id, label: bill.name },
      });
    }
  }

  const cardBills = activeBills.filter(
    (bill) => bill.accountId !== null && cardByAccountId.has(bill.accountId),
  );
  const cashBills = activeBills.filter((bill) => !cardBills.includes(bill));

  events.push(
    ...tagLabels(
      projectRecurrences(cashBills.map(ruleForBill), range),
      labels,
      cashBills.map((bill) => [`recurring:bill:${bill.id}`, bill.name]),
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
  recurring.forEach((rule, index) => {
    if (!rule.categoryId || rule.amountMinor >= 0) return;
    for (const occurrence of projectRecurrences([recurringRules[index]!], commitmentRange)) {
      commitments.push({
        categoryId: rule.categoryId,
        date: occurrence.expectedAt,
        amountMinor: -occurrence.amountMinor,
        source: { kind: "recurring_rule", id: rule.id, label: rule.name },
      });
    }
  });

  // 4. Credit-card statements: one cash settlement per billing cycle.
  if (cards.length > 0) {
    const cardIds = [...cardById.keys()];
    const allRecorded = await db.query.creditCardBillingCycles.findMany({
      where: inArray(creditCardBillingCycles.creditCardId, cardIds),
      orderBy: [asc(creditCardBillingCycles.dueAt)],
    });
    // A recorded cycle owns its month whatever its due date: deriving the same
    // month from the ledger when the recorded one fell out of the window (it is
    // past due, or the card's due day moved) projected it a second time under a
    // `derived` id, as if no statement had ever been recorded.
    const recordedMonths = new Set(
      allRecorded.map((cycle) => `${cycle.creditCardId}:${cycle.statementMonth.slice(0, 7)}`),
    );
    // A settled cycle is a fact, not a projection: it leaves the active set.
    const openCycles = allRecorded.filter(
      (cycle) => cycle.status !== "paid" && cycle.dueAt >= asOf && cycle.dueAt <= horizonEnd,
    );

    const charges: CycleCharge[] = [];
    const cycleSource = new Map<string, ProjectedCardStatement["cycleSource"]>();
    const components = new Map<string, StatementComponent[]>();
    const addCharge = (cycleId: string, component: StatementComponent) => {
      charges.push({ billingCycleId: cycleId, amountMinor: component.amountMinor });
      const list = components.get(cycleId) ?? [];
      list.push(component);
      components.set(cycleId, list);
    };

    const recordedId = (id: string) => `recorded:${id}`;
    const billingCycles: BillingCycle[] = openCycles.map((cycle) => {
      cycleSource.set(recordedId(cycle.id), cycle.source === "pluggy" ? "open_finance" : "recorded");
      return {
        // Prefixed so the statement event's id says where the cycle came from,
        // as the derived and synthesized ones already do.
        id: recordedId(cycle.id),
        creditCardId: cycle.creditCardId,
        statementMonth: cycle.statementMonth.slice(0, 7),
        dueAt: cycle.dueAt,
        confirmedTotalMinor: cycle.confirmedTotalMinor ?? undefined,
      };
    });
    for (const charge of await loadCycleCharges(openCycles.map((cycle) => cycle.id))) {
      addCharge(recordedId(charge.billingCycleId), {
        kind: "installment",
        amountMinor: charge.amountMinor,
        purchaseId: charge.purchaseId,
        description: charge.description,
        number: charge.number,
        totalInstallments: charge.totalInstallments,
        status: charge.status,
      });
    }

    // A card imported from a bank export has no recorded cycle at all — only
    // ledger transactions. Without deriving its statements the same way
    // `getCardStatement` does, the card's entire debt is invisible to the
    // forecast and to safe-to-spend, no matter how many transactions it has.
    const cardAccounts = await db.query.accounts.findMany({
      where: inArray(accounts.id, cards.map((card) => card.accountId)),
      columns: { id: true, currentBalanceMinor: true },
    });
    const debtByAccountId = new Map(
      cardAccounts.map((account) => [account.id, Math.max(0, -account.currentBalanceMinor)]),
    );
    const unplacedByCard = new Map<string, number>();
    for (const card of cards) {
      const derived = await deriveLedgerCycles(userId, card);

      // How much of each statement is still owed. `allocateCardDebt` owns the
      // rule — including where debt that spills onto an already-overdue cycle
      // goes, which is forward onto the next statement rather than off the
      // horizon entirely.
      const allocation = allocateCardDebt(
        [...derived.entries()].map(([statementMonth, entry]) => ({
          statementMonth,
          dueAt: entry.dueAt,
          chargesMinor: entry.chargesMinor,
        })),
        debtByAccountId.get(card.accountId) ?? 0,
        asOf,
      );
      if (allocation.unplacedMinor > 0) unplacedByCard.set(card.id, allocation.unplacedMinor);

      for (const [month, billedMinor] of allocation.billedByStatementMonth) {
        if (recordedMonths.has(`${card.id}:${month}`)) continue;
        const dueAt = derived.get(month)?.dueAt;
        if (!dueAt || dueAt < asOf || dueAt > horizonEnd) continue;

        const id = `derived:${card.id}:${month}`;
        cycleSource.set(id, "derived");
        billingCycles.push({ id, creditCardId: card.id, statementMonth: month, dueAt });
        addCharge(id, { kind: "posted_charges", amountMinor: billedMinor });
      }
    }

    // The bills held back in step 2. Each occurrence is a charge on whichever
    // statement was open on the day it posts, so the cash leaves on that
    // statement's due date — the same rule a card purchase follows, because it
    // is the same thing. A month the card has no cycle for yet gets one
    // synthesized: without it the charge would land nowhere and the bill would
    // vanish from the horizon entirely, which is worse than dating it early.
    //
    // The bill's own confidence is lost here, and deliberately: a statement is
    // one cash event, and a mixed-provenance total has no single confidence to
    // report. `projectStatements` rates it HIGH, or CONFIRMED once the real
    // statement total is recorded.
    const cycleIdByCardMonth = new Map(
      billingCycles.map((cycle) => [`${cycle.creditCardId}:${cycle.statementMonth}`, cycle.id]),
    );
    for (const bill of cardBills) {
      const card = cardByAccountId.get(bill.accountId!)!;
      for (const occurrence of projectRecurrences([ruleForBill(bill)], range)) {
        const nominal = nominalCycleFor(
          occurrence.expectedAt,
          card.defaultClosingDay,
          card.defaultDueDay,
        );
        if (nominal.dueAt < asOf || nominal.dueAt > horizonEnd) continue;
        const key = `${card.id}:${nominal.statementMonth}`;
        let cycleId = cycleIdByCardMonth.get(key);
        if (cycleId === undefined) {
          cycleId = `bill-cycle:${card.id}:${nominal.statementMonth}`;
          cycleIdByCardMonth.set(key, cycleId);
          cycleSource.set(cycleId, "synthesized");
          billingCycles.push({
            id: cycleId,
            creditCardId: card.id,
            statementMonth: nominal.statementMonth,
            dueAt: nominal.dueAt,
          });
        }
        // Charges are positive magnitudes; the rule's amount is an outflow.
        addCharge(cycleId, {
          kind: "card_bill",
          amountMinor: Math.abs(occurrence.amountMinor),
          billId: bill.id,
          name: bill.name,
          chargedAt: occurrence.expectedAt,
        });
      }
    }

    // Installments the card has committed to but not yet charged.
    //
    // A future statement is made of the parcels falling due in it, and those
    // live in `installments`, not in the ledger — a parcel becomes a
    // transaction only when the issuer posts it. Reading only transactions
    // therefore showed future statements as almost empty: on this data,
    // November projected the two subscriptions charged to the card and nothing
    // else, while the issuer's own app showed ten times that.
    //
    // Only `projected` rows are added. A `billed` parcel already exists as a
    // transaction on the card and was counted above; adding it again would
    // charge the same money twice (PRD R3). Nor is a parcel assigned to a
    // recorded cycle: `loadCycleCharges` already counted it on that cycle, or
    // the cycle is settled — adding it here doubled every statement of a
    // purchase registered by hand.
    const projectedInstallments = await db
      .select({
        cardId: creditCardPurchases.creditCardId,
        expectedAt: installments.expectedAt,
        amountMinor: installments.amountMinor,
        number: installments.number,
        purchaseId: creditCardPurchases.id,
        totalInstallments: installmentPlans.totalInstallments,
        description: transactions.description,
      })
      .from(installments)
      .innerJoin(installmentPlans, eq(installmentPlans.id, installments.installmentPlanId))
      .innerJoin(creditCardPurchases, eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId))
      .innerJoin(creditCards, eq(creditCards.id, creditCardPurchases.creditCardId))
      .innerJoin(transactions, eq(transactions.id, creditCardPurchases.transactionId))
      .where(
        and(
          eq(creditCards.userId, userId),
          eq(installments.status, "projected"),
          isNull(installments.billingCycleId),
          gte(installments.expectedAt, asOf),
        ),
      )
      .orderBy(asc(installments.expectedAt), asc(installments.id));

    const futureParcelsByCard = new Map<string, number>();
    for (const installment of projectedInstallments) {
      const card = cardById.get(installment.cardId);
      if (!card) continue;
      futureParcelsByCard.set(card.id, (futureParcelsByCard.get(card.id) ?? 0) + installment.amountMinor);
      if (installment.expectedAt > horizonEnd) continue;
      // `expectedAt` is the parcel's due date, so the statement it belongs to is
      // the one that falls due then — the same inverse the provider's bills use,
      // which is what keeps a parcel and a bill landing on one cycle.
      const statementMonth = statementMonthForDueDate(
        installment.expectedAt,
        card.defaultClosingDay,
        card.defaultDueDay,
      );
      const key = `${card.id}:${statementMonth}`;
      let cycleId = cycleIdByCardMonth.get(key);
      if (cycleId === undefined) {
        cycleId = `installment-cycle:${card.id}:${statementMonth}`;
        cycleIdByCardMonth.set(key, cycleId);
        cycleSource.set(cycleId, "synthesized");
        billingCycles.push({
          id: cycleId,
          creditCardId: card.id,
          statementMonth,
          dueAt: installment.expectedAt,
        });
      }
      addCharge(cycleId, {
        kind: "installment",
        amountMinor: installment.amountMinor,
        purchaseId: installment.purchaseId,
        description: installment.description,
        number: installment.number,
        totalInstallments: installment.totalInstallments,
        status: "projected",
      });
    }

    for (const [cardId, unplacedMinor] of unplacedByCard) {
      const futureInstallmentsMinor = futureParcelsByCard.get(cardId) ?? 0;
      cardDebtUnplaced.push({
        cardId,
        cardName: cardById.get(cardId)!.name,
        unplacedMinor,
        futureInstallmentsMinor,
        unexplainedMinor: Math.max(0, unplacedMinor - futureInstallmentsMinor),
      });
    }

    const statementEvents = projectStatements(billingCycles, charges, range);
    const cycleById = new Map(billingCycles.map((cycle) => [cycle.id, cycle]));
    for (const event of statementEvents) {
      const cycle = cycleById.get(event.id.slice("statement:".length));
      if (!cycle) continue;
      const parts = components.get(cycle.id) ?? [];
      cardStatements.push({
        cardId: cycle.creditCardId,
        cardName: cardById.get(cycle.creditCardId)?.name ?? cycle.creditCardId,
        statementMonth: cycle.statementMonth,
        dueAt: cycle.dueAt,
        logicalKey: event.logicalKey,
        eventId: event.id,
        cycleSource: cycleSource.get(cycle.id) ?? "synthesized",
        amountMinor: -event.amountMinor,
        confidence: event.confidence,
        confirmedTotalMinor: cycle.confirmedTotalMinor ?? null,
        componentsTotalMinor: parts.reduce((total, part) => total + part.amountMinor, 0),
        components: parts,
      });
    }
    for (const cycle of billingCycles) {
      const card = cardById.get(cycle.creditCardId);
      if (card) labels.set(`statement:${cycle.creditCardId}:${cycle.statementMonth}`, `Fatura ${card.name}`);
    }
    events.push(...statementEvents);
  }

  // 5. Variable spending the budgets still allow (see `projectBudgetConsumption`).
  // Kept apart from the commitments so `forecastForScenario` can show the
  // forecast without it, without building the forecast twice.
  const budgetConsumption = await loadBudgetConsumption({
    userId,
    asOf,
    horizonEnd,
    currencyCode: settings.currencyCode,
    cards: cards.map((card) => ({
      id: card.id,
      accountId: card.accountId,
      name: card.name,
      closingDay: card.defaultClosingDay,
      dueDay: card.defaultDueDay,
    })),
    commitments,
  });
  for (const event of budgetConsumption.events) {
    const budgetId = event.logicalKey.split(":")[1]!;
    labels.set(event.logicalKey, `Estimated spending · ${budgetConsumption.budgetNames.get(budgetId) ?? "budget"}`);
  }
  const commitmentEvents = [...events];
  if (scenario !== "none") events.push(...budgetConsumption.events);

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

  return {
    forecast,
    labels,
    position,
    cardDebtUnplaced,
    cardStatements,
    scenario,
    commitmentEvents,
    budgetConsumption,
  };
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

/** Installments assigned to recorded cycles, with what a statement breakdown names them by. */
async function loadCycleCharges(cycleIds: string[]) {
  if (cycleIds.length === 0) return [];
  return db
    .select({
      billingCycleId: installments.billingCycleId,
      amountMinor: installments.amountMinor,
      number: installments.number,
      status: installments.status,
      purchaseId: creditCardPurchases.id,
      totalInstallments: installmentPlans.totalInstallments,
      description: transactions.description,
    })
    .from(installments)
    .innerJoin(installmentPlans, eq(installmentPlans.id, installments.installmentPlanId))
    .innerJoin(creditCardPurchases, eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId))
    .innerJoin(transactions, eq(transactions.id, creditCardPurchases.transactionId))
    .where(
      and(
        inArray(installments.billingCycleId, cycleIds),
        inArray(installments.status, ["projected", "billed"]),
      ),
    )
    .orderBy(asc(installments.expectedAt), asc(installments.id))
    .then((rows) =>
      rows.flatMap((row) => (row.billingCycleId === null ? [] : [{ ...row, billingCycleId: row.billingCycleId }])),
    );
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

/** Every reserve the user has configured, active or not, for management UI. */
export async function listFinancialReserves(userId: string) {
  return db.query.financialReserves.findMany({
    where: eq(financialReserves.userId, userId),
    orderBy: [desc(financialReserves.isActive), asc(financialReserves.kind), asc(financialReserves.name)],
  });
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

export interface SpendingRoomOption {
  /** Null for cash, which settles today. */
  cardId: string | null;
  label: string;
  /** The day a purchase made today actually leaves the account. */
  settlementDate: string;
  amountMinor: number;
}

export interface SpendingRoomView {
  /** The headline: the most room any single route offers. */
  safeToSpendMinor: number;
  bestOption: SpendingRoomOption;
  options: SpendingRoomOption[];
  /** The forecast's low point today, and the floor the room is measured to. */
  minimumBalanceMinor: number;
  minimumBalanceDate: string;
  floorMinor: number;
  hardReserveViolated: boolean;
  hardReserveMinor: number;
  /** Everything the horizon expects to pay out, as a positive magnitude. */
  committedMinor: number;
  /**
   * How much of that the budgets' variable-spending estimate accounts for —
   * already inside `committedMinor`, broken out because it is an assumption,
   * not a commitment.
   */
  estimatedVariableMinor: number;
  /** The scenario the headline is computed under. */
  scenario: VariableSpendingScenario;
  /**
   * The headline with and without the budgets' reservation, so its effect is
   * visible: `none` is the room if nothing beyond commitments were spent.
   */
  safeToSpendByScenario: Record<VariableSpendingScenario, number>;
  staleAccountNames: string[];
  forecast: Forecast;
  position: FinancePosition;
}

const VARIABLE_SPENDING_SCENARIOS: VariableSpendingScenario[] = ["none", "budget"];

function outflowMinor(events: ForecastEvent[]): number {
  return events.filter((event) => event.amountMinor < 0).reduce((total, event) => total + -event.amountMinor, 0);
}

/**
 * What is left to spend this month before next month stops landing on zero.
 *
 * The figure is the projected low from the settlement date onward, measured
 * against the reserve — so spending exactly it lands next month's worst day on
 * the floor, and a negative figure says the forecast is already that far below
 * it before anything new is bought.
 *
 * Cash leaves the account now, so it is constrained by the whole horizon —
 * including a dip before payday the money would have to survive. A card charge
 * leaves on its statement's due date, so only what comes after that constrains
 * it. Every route is reported, not just the winner, because which card to reach
 * for is the decision this number exists to inform.
 */
export async function getSafeToSpend(
  userId: string,
  horizonDays = 60,
  scenario: VariableSpendingScenario = DEFAULT_VARIABLE_SPENDING,
): Promise<SpendingRoomView> {
  const [detailed, hardReserveMinor, cards] = await Promise.all([
    buildUserForecastDetailed(userId, horizonDays, { variableSpending: scenario }),
    getHardReserveMinor(userId),
    listCreditCards(userId),
  ]);
  const { forecast, position } = detailed;

  const asOf = forecast.asOf;

  const routes: { cardId: string | null; label: string; settlementDate: string }[] = [
    { cardId: null, label: "À vista", settlementDate: asOf },
    ...cards.map((card) => ({
      cardId: card.id,
      label: card.name,
      // A purchase today lands on whichever statement is open today, and that
      // statement's due date is when the cash actually goes.
      settlementDate: nominalCycleFor(asOf, card.defaultClosingDay, card.defaultDueDay).dueAt,
    })),
  ];

  const roomUnder = (projected: Forecast) => {
    const forecastInput = {
      asOf,
      horizonEnd: projected.horizonEnd,
      balances: [{ accountId: "consolidated", amountMinor: projected.openingBalanceMinor, observedAt: asOf }],
      events: projected.events,
    };
    let floorMinor = 0;
    let hardReserveViolated = false;
    const options = routes.map((route) => {
      const room = calculateSpendingRoom({ forecastInput, hardReserveMinor, settlementDate: route.settlementDate });
      floorMinor = room.floorMinor;
      hardReserveViolated = room.hardReserveViolated;
      return { ...route, amountMinor: room.spendingRoomMinor };
    });
    const bestOption = options.reduce((best, option) => (option.amountMinor > best.amountMinor ? option : best));
    return { options, bestOption, floorMinor, hardReserveViolated };
  };

  const { options, bestOption, floorMinor, hardReserveViolated } = roomUnder(forecast);
  const safeToSpendByScenario = Object.fromEntries(
    VARIABLE_SPENDING_SCENARIOS.map((candidate) => [
      candidate,
      candidate === scenario
        ? bestOption.amountMinor
        : roomUnder(forecastForScenario(detailed, candidate)).bestOption.amountMinor,
    ]),
  ) as Record<VariableSpendingScenario, number>;

  return {
    safeToSpendMinor: bestOption.amountMinor,
    bestOption,
    options: [...options].sort((a, b) => b.amountMinor - a.amountMinor),
    minimumBalanceMinor: forecast.minimumBalanceMinor,
    minimumBalanceDate: forecast.minimumBalanceDate,
    floorMinor,
    hardReserveViolated,
    hardReserveMinor,
    committedMinor: outflowMinor(forecast.events),
    estimatedVariableMinor: outflowMinor(
      forecast.events.filter((event) => event.sourceType === BUDGET_ESTIMATE_SOURCE),
    ),
    scenario,
    safeToSpendByScenario,
    staleAccountNames: position.staleAccountNames,
    forecast,
    position,
  };
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

export interface MonthBalance {
  /** Projected balance on the last day of the month the horizon covers. */
  closingBalanceMinor: number;
  /** The month's worst day — the one that decides whether it is survivable. */
  lowMinor: number;
  lowDate: string;
}

export interface MonthOutlook extends MonthBalance {
  /** `YYYY-MM`. */
  month: string;
  isCurrentMonth: boolean;
  /** Variable spending the budgets still allow in the month, already in the figures. */
  estimatedVariableMinor: number;
}

export function monthBalances(forecast: Forecast): Map<string, MonthBalance> {
  const byMonth = new Map<string, MonthBalance>();
  for (const day of forecast.days) {
    const month = day.date.slice(0, 7);
    const entry = byMonth.get(month);
    if (!entry) {
      byMonth.set(month, { closingBalanceMinor: day.closingBalanceMinor, lowMinor: day.closingBalanceMinor, lowDate: day.date });
      continue;
    }
    // Days arrive in order, so the last one seen is the month's closing day.
    entry.closingBalanceMinor = day.closingBalanceMinor;
    if (day.closingBalanceMinor < entry.lowMinor) {
      entry.lowMinor = day.closingBalanceMinor;
      entry.lowDate = day.date;
    }
  }
  return byMonth;
}

/** Last calendar day of the month `offset` months after `isoMonth`'s month. */
function endOfMonth(isoDay: string, offset: number): string {
  const [year, month] = isoDay.slice(0, 7).split("-").map(Number);
  // Day 0 of the following month is the last day of the one before it.
  const end = new Date(Date.UTC(year!, month! + offset, 0));
  return end.toISOString().slice(0, 10);
}

/**
 * Where the balance lands at the end of this month and the next few.
 *
 * Both numbers are reported per month because they answer different questions.
 * The closing balance says how the month ends; the low says whether it can be
 * lived through — a month can close comfortably and still spend a week
 * overdrawn, and on this data the worst day is routinely not the one the
 * statement falls on.
 */
export async function getMonthlyOutlook(userId: string, months = 4): Promise<MonthOutlook[]> {
  return (await getBudgetForecast(userId, months)).outlook;
}

export interface BudgetForecastEstimate extends BudgetMonthEstimate {
  budgetName: string;
  /** `allocations` with each route named: 'Cash' or the card's name. */
  routeMix: Array<BudgetMonthEstimate["allocations"][number] & { label: string }>;
}

export interface BudgetForecast {
  /** Last day the forecast behind `outlook` covers; estimate events after it are `beyondHorizonMinor`. */
  horizonEnd: string;
  outlook: MonthOutlook[];
  /** Per budget and month, how each scenario's estimate was reached. */
  estimates: BudgetForecastEstimate[];
  /** Budgets left out of the estimate, and why. */
  blockers: Array<BudgetConsumptionBlocker & { budgetName: string }>;
}

/**
 * The monthly outlook together with the budget estimates behind it, from one
 * forecast build, so the two can never disagree.
 */
export async function getBudgetForecast(userId: string, months = 4): Promise<BudgetForecast> {
  const today = todayIso();
  const horizonEnd = endOfMonth(today, months);
  const horizonDays = Math.max(
    1,
    Math.round((Date.parse(`${horizonEnd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
  );
  const detailed = await buildUserForecastDetailed(userId, horizonDays, { variableSpending: "budget" });

  const estimated = new Map<string, number>();
  for (const estimate of detailed.budgetConsumption.estimates) {
    estimated.set(estimate.month, (estimated.get(estimate.month) ?? 0) + estimate.remainingMinor);
  }

  const outlook = [...monthBalances(detailed.forecast).entries()].slice(0, months).map(([month, balance]) => ({
    month,
    ...balance,
    isCurrentMonth: month === today.slice(0, 7),
    estimatedVariableMinor: estimated.get(month) ?? 0,
  }));
  const shown = new Set(outlook.map((entry) => entry.month));
  const { budgetNames, cardNames } = detailed.budgetConsumption;
  return {
    horizonEnd: detailed.forecast.horizonEnd,
    outlook,
    estimates: detailed.budgetConsumption.estimates
      .filter((estimate) => shown.has(estimate.month))
      .map((estimate) => ({
        ...estimate,
        budgetName: budgetNames.get(estimate.budgetId) ?? estimate.budgetId,
        routeMix: estimate.allocations.map((allocation) => ({
          ...allocation,
          label: allocation.cardId === null ? "Cash" : (cardNames.get(allocation.cardId) ?? allocation.cardId),
        })),
      })),
    blockers: detailed.budgetConsumption.blockers.map((blocker) => ({
      ...blocker,
      budgetName: budgetNames.get(blocker.budgetId) ?? blocker.budgetId,
    })),
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
    // An estimate of variable spending is an assumption, not something owed.
    .filter((event) => event.amountMinor < 0 && event.sourceType !== BUDGET_ESTIMATE_SOURCE)
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

  // Scoped to this user's cards in the query itself: a tenant must never read
  // another's schedule, not even to discard it afterwards.
  const scheduled = await db
    .select({ cardId: creditCardPurchases.creditCardId, amountMinor: installments.amountMinor })
    .from(installments)
    .innerJoin(installmentPlans, eq(installmentPlans.id, installments.installmentPlanId))
    .innerJoin(creditCardPurchases, eq(creditCardPurchases.id, installmentPlans.creditCardPurchaseId))
    .where(
      and(
        inArray(
          creditCardPurchases.creditCardId,
          cards.map((card) => card.id),
        ),
        gte(installments.expectedAt, todayIso()),
        inArray(installments.status, ["projected", "billed"]),
      ),
    );
  const scheduledByCard = new Map<string, number>();
  for (const item of scheduled) {
    scheduledByCard.set(item.cardId, (scheduledByCard.get(item.cardId) ?? 0) + item.amountMinor);
  }

  return cards.map((card) => {
    // A card account holds a negative balance while money is owed.
    const committedMinor = Math.max(0, -(card.account?.currentBalanceMinor ?? 0));
    return {
      ...card,
      committedMinor,
      /**
       * Instalment parcels of this card on statements due from today on:
       * projected parcels plus billed ones whose statement is not yet due. Part
       * of `committedMinor` whenever the provider counts future parcels in the
       * balance, as issuers do.
       */
      scheduledInstallmentsMinor: scheduledByCard.get(card.id) ?? 0,
      availableLimitMinor: card.creditLimitMinor - committedMinor,
      utilizationPercent:
        card.creditLimitMinor > 0 ? Math.round((committedMinor / card.creditLimitMinor) * 100) : 0,
    };
  });
}

/**
 * Where a billing cycle's numbers came from, so the UI can say so (PRD R7).
 * `open_finance` is a recorded cycle whose total the institution confirmed,
 * which is why it outranks anything derived from the ledger.
 */
export type CycleSource = "recorded" | "derived" | "open_finance";

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

export interface DerivedLedgerCycle {
  closesAt: string;
  dueAt: string;
  /** Purchases and fees posted in the period, as a positive magnitude. */
  chargesMinor: number;
  /** Payments and refunds posted in the period, as a positive magnitude. */
  creditsMinor: number;
}

/**
 * Groups a card account's ledger transactions into the billing cycles they
 * would fall into, using the card's nominal closing and due days.
 *
 * A card imported from a bank export has no recorded `CreditCardBillingCycle`
 * rows — only transactions. Both the statement history view and the forecast
 * need the same derivation, so it lives here once rather than being
 * approximated twice: without it, a card's debt is invisible to whichever
 * caller skips this step.
 */
async function deriveLedgerCycles(
  userId: string,
  card: { id: string; accountId: string; defaultClosingDay: number; defaultDueDay: number },
): Promise<Map<string, DerivedLedgerCycle>> {
  const [ownRows, incomingTransfers] = await Promise.all([
    db.query.transactions.findMany({
      where: and(
        eq(transactions.userId, userId),
        eq(transactions.accountId, card.accountId),
        isNull(transactions.deletedAt),
      ),
      columns: { date: true, amountMinor: true },
    }),
    // Paying the bill from a bank account is a transfer, and a transfer is one
    // row on the *source* account — its destination leg is derived, never
    // stored (PRD R5). Reading only rows whose `accountId` is the card
    // therefore sees every purchase and not one single payment, which is what
    // made a settled card keep its debt forever.
    db.query.transactions.findMany({
      where: and(
        eq(transactions.userId, userId),
        eq(transactions.transferAccountId, card.accountId),
        isNull(transactions.deletedAt),
      ),
      columns: { date: true, amountMinor: true },
    }),
  ]);

  const byMonth = new Map<string, DerivedLedgerCycle>();
  const post = (date: string, chargeMinor: number, creditMinor: number) => {
    const cycle = nominalCycleFor(date, card.defaultClosingDay, card.defaultDueDay);
    const existing = byMonth.get(cycle.statementMonth) ?? {
      closesAt: cycle.closesAt,
      dueAt: cycle.dueAt,
      chargesMinor: 0,
      creditsMinor: 0,
    };
    existing.chargesMinor += chargeMinor;
    existing.creditsMinor += creditMinor;
    byMonth.set(cycle.statementMonth, existing);
  };

  for (const entry of ownRows) {
    if (entry.amountMinor < 0) post(entry.date, -entry.amountMinor, 0);
    else post(entry.date, 0, entry.amountMinor);
  }
  // The stored leg is the outflow from the payer; on the card it is a credit.
  for (const entry of incomingTransfers) post(entry.date, 0, Math.abs(entry.amountMinor));

  return byMonth;
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

  const derived = await deriveLedgerCycles(userId, card);
  const today = todayIso();
  const byMonth = new Map<string, CardStatementCycle>();
  for (const [month, entry] of derived) {
    byMonth.set(month, {
      id: `derived:${cardId}:${month}`,
      statementMonth: month,
      closesAt: entry.closesAt,
      dueAt: entry.dueAt,
      chargesMinor: entry.chargesMinor,
      creditsMinor: entry.creditsMinor,
      // Charges only. A payment posted inside this period settles the *previous*
      // statement — paying the August bill on 5 September posts in September —
      // so subtracting it here cancels the wrong month and can drive an open
      // statement negative. Which statement a payment settled is reconciliation
      // (PRD §29) and cannot be inferred from dates; the credits stay reported
      // beside the total rather than inside it.
      totalMinor: entry.chargesMinor,
      isReconciled: false,
      source: "derived",
      // A derived cycle carries no recorded status, so the only honest one is
      // the one its own dates give: it is open until the day it closes. It was
      // being stamped "closed" unconditionally, which told you the month you
      // are still spending in had already shut.
      //
      // It never becomes "paid" or "overdue" here. Deciding that a payment
      // settled a particular statement is reconciliation (PRD §29) — and it
      // cannot be inferred from dates, since a bill is normally paid in the
      // period *after* the one it belongs to.
      status: today <= entry.closesAt ? "open" : "closed",
    });
  }

  // A recorded cycle always wins over the derived one for the same month.
  for (const cycle of recorded) {
    const month = cycle.statementMonth.slice(0, 7);
    const chargedMinor = cycle.installments
      .filter((item) => item.status !== "cancelled")
      .reduce((total, item) => total + item.amountMinor, 0);
    const totalMinor = cycle.confirmedTotalMinor ?? chargedMinor;
    byMonth.set(month, {
      id: cycle.id,
      statementMonth: month,
      // A cycle recorded before it closed has no closing date yet. Its opening
      // date is not one — showing it read as a statement closing a month early
      // — so the nominal closing day of its own month stands in.
      closesAt:
        cycle.closedAt ?? nominalCycleFor(`${month}-01`, card.defaultClosingDay, card.defaultDueDay).closesAt,
      dueAt: cycle.dueAt,
      chargesMinor: chargedMinor,
      creditsMinor: 0,
      totalMinor,
      isReconciled: cycle.confirmedTotalMinor !== null,
      // A cycle the institution itself confirmed says so, so the card screen can
      // distinguish "you typed this total" from "the bank published it" (R7).
      source: cycle.source === "pluggy" ? "open_finance" : "recorded",
      // Nothing owed cannot be overdue.
      status: cycle.status === "overdue" && totalMinor <= 0 ? "paid" : cycle.status,
    });
  }

  const cycles = [...byMonth.values()].sort((left, right) =>
    right.statementMonth.localeCompare(left.statementMonth),
  );

  return { card, cycles };
}

type PlanItemTotals = {
  /** Everything the plan still means to buy, plus what it already bought. */
  estimatedTotalMinor: number;
  /** The slice not bought yet — what the plan still commits you to. */
  remainingEstimateMinor: number;
  /** What the purchased items actually cost. */
  purchasedTotalMinor: number;
  /** How far past the budget the plan runs; 0 when it fits, null when unbudgeted. */
  overBudgetMinor: number | null;
  /** How much of the budget is still unspoken for; 0 when over, null when unbudgeted. */
  underBudgetMinor: number | null;
};

/**
 * What a plan adds up to.
 *
 * Summed here rather than in the page because the UI's job is to format a
 * number someone else decided. A purchased item counts at what it actually
 * cost, not at the guess it was created with; a cancelled or switched-off one
 * counts for nothing. Every item is priced in its plan's currency, which is
 * what makes a plain sum legitimate.
 */
function totalsFor(
  items: Array<{
    status: string;
    isActive: boolean;
    estimatedPriceMinor: number;
    actualPriceMinor: number | null;
  }>,
  budgetMinor: number | null,
): PlanItemTotals {
  let estimatedTotalMinor = 0;
  let remainingEstimateMinor = 0;
  let purchasedTotalMinor = 0;

  for (const item of items) {
    if (item.status === "cancelled" || !item.isActive) continue;
    const priced = item.actualPriceMinor ?? item.estimatedPriceMinor;
    estimatedTotalMinor += priced;
    if (item.status === "purchased") purchasedTotalMinor += priced;
    else remainingEstimateMinor += priced;
  }

  return {
    estimatedTotalMinor,
    remainingEstimateMinor,
    purchasedTotalMinor,
    overBudgetMinor:
      budgetMinor === null ? null : Math.max(0, estimatedTotalMinor - budgetMinor),
    underBudgetMinor:
      budgetMinor === null ? null : Math.max(0, budgetMinor - estimatedTotalMinor),
  };
}

export async function listPurchasePlans(userId: string) {
  const plans = await db.query.purchasePlans.findMany({
    where: eq(purchasePlans.userId, userId),
    with: { items: { with: { paymentOptions: true } } },
    orderBy: [asc(purchasePlans.targetDate)],
  });
  return plans.map((plan) => ({ ...plan, ...totalsFor(plan.items, plan.budgetMinor) }));
}

export async function getPurchasePlan(userId: string, id: string) {
  const plan = await db.query.purchasePlans.findFirst({
    where: and(eq(purchasePlans.id, id), eq(purchasePlans.userId, userId)),
    with: { items: { with: { paymentOptions: true, simulations: true } } },
  });
  return plan ? { ...plan, ...totalsFor(plan.items, plan.budgetMinor) } : undefined;
}

/**
 * One purchase item with its parent plan, or undefined when the item does not
 * exist or its plan belongs to someone else. Items carry no userId of their
 * own, so tenancy is the plan's.
 */
export async function getPurchaseItem(userId: string, itemId: string) {
  const item = await db.query.purchaseItems.findFirst({
    where: eq(purchaseItems.id, itemId),
    with: { purchasePlan: true },
  });
  return item && item.purchasePlan.userId === userId ? item : undefined;
}

export interface PurchasePlanImpactResult {
  plan: NonNullable<Awaited<ReturnType<typeof getPurchasePlan>>>;
  /** Undefined only when no item in the plan carries both an account and a purchase date. */
  simulation?: PurchasePlanSimulation;
  /**
   * The forecast without the plan, over the very horizon the simulation was
   * measured on. Returned rather than left to the caller to rebuild: the two
   * series are only comparable while they share one `asOf` and one
   * `horizonEnd`, and that horizon is derived here. Undefined exactly when
   * `simulation` is.
   */
  baseline?: UserForecast;
  /** Items missing an account or a purchase date — excluded from the simulation, reported instead of silently dropped. */
  unprojectedItems: Array<{ id: string; name: string }>;
  /** Items the user switched off (isActive=false): out of the projection on purpose, listed so that is visible. */
  inactiveItems: Array<{ id: string; name: string }>;
  /** The horizon the simulation was measured over; undefined exactly when `simulation` is. */
  horizonDays?: number;
}

export interface PurchasePlanImpactOptions {
  /**
   * Shortest horizon to look at, in days; defaults to `MIN_PLAN_HORIZON_DAYS`.
   * Always stretched to cover the plan's last settlement.
   */
  horizonDays?: number;
  /** Whether the baseline carries the budgets' estimate; defaults to `budget`. */
  scenario?: VariableSpendingScenario;
}

/**
 * How far a plan is looked at when its own instalments do not reach further.
 * A plan paid off next month still gets asked the same question as one paid
 * off next year: what does the year ahead look like.
 */
const MIN_PLAN_HORIZON_DAYS = 365;

/**
 * What this plan's items do to the horizon.
 *
 * Each item carries everything it needs to become one `PaymentOption`: a
 * credit-card account settles it on that card's real cycles over its own
 * `installments`; any other account settles it in full on the purchase date
 * (`toEnginePaymentOption`'s existing dispatch, not reimplemented here). The
 * result is handed straight to `simulatePurchasePlan`, which owns the verdict.
 */
export async function getPurchasePlanImpact(
  userId: string,
  planId: string,
  options: PurchasePlanImpactOptions = {},
): Promise<PurchasePlanImpactResult | undefined> {
  const plan = await getPurchasePlan(userId, planId);
  if (!plan) return undefined;

  // One read for every item this function resolves into a payment option,
  // instead of each item re-reading the cards, their cycles and the
  // installment ledger on its own.
  const cardContext = await loadCardContext(userId);
  const cardByAccountId = new Map(cardContext.cards.map((card) => [card.accountId, card]));

  const unprojectedItems: Array<{ id: string; name: string }> = [];
  const inactiveItems: Array<{ id: string; name: string }> = [];
  const projectable: Array<(typeof plan.items)[number] & { accountId: string; purchaseDate: string }> = [];
  for (const item of plan.items) {
    // Switched off by the user: out of the projection on purpose, so it is
    // not simulated — but listed, so its absence is never silent.
    if (!item.isActive) {
      inactiveItems.push({ id: item.id, name: item.name });
      continue;
    }
    if (!item.accountId || !item.purchaseDate) {
      unprojectedItems.push({ id: item.id, name: item.name });
      continue;
    }
    projectable.push({ ...item, accountId: item.accountId, purchaseDate: item.purchaseDate });
  }

  if (projectable.length === 0) {
    return { plan, simulation: undefined, baseline: undefined, unprojectedItems, inactiveItems };
  }

  const items: PlanItemOption[] = await Promise.all(
    projectable.map(async (item) => {
      const card = cardByAccountId.get(item.accountId);
      const option = await toEnginePaymentOption(
        userId,
        {
          id: item.id,
          label: item.name,
          method: card ? "credit_card" : "cash",
          amountMinor: item.estimatedPriceMinor,
          cardId: card ? card.id : null,
          installments: card ? item.installments : 1,
          purchaseDate: item.purchaseDate,
        },
        cardContext,
      );
      return { itemId: item.id, label: item.name, option, purchaseDate: item.purchaseDate };
    }),
  );

  // The horizon has to outlast the plan. `buildForecast` keeps only the
  // events inside [asOf, horizonEnd] and drops the rest without a word, so a
  // fixed year would cut the tail off anything bought late in it: the last
  // instalments would be absent from the trough and absent from the monthly
  // outlook, and the plan would read cheaper than it is. Stretching to
  // the end of the month the final instalment lands in also keeps that closing
  // row a whole month, like every other row in the table.
  //
  // This is why the forecast cannot be built alongside the options above: the
  // horizon is not knowable until the settlement dates are.
  const asOf = todayIso();
  const lastPaymentDate = items
    .flatMap((item) => item.option.cashEvents.map((event) => event.expectedAt))
    .reduce((latest, date) => (date > latest ? date : latest), asOf);
  const horizonDays = Math.max(
    options.horizonDays ?? MIN_PLAN_HORIZON_DAYS,
    daysBetween(asOf, monthRange(lastPaymentDate).end),
  );

  const [baseline, hardReserveMinor, softReserves] = await Promise.all([
    buildUserForecastDetailed(userId, horizonDays, { variableSpending: options.scenario ?? DEFAULT_VARIABLE_SPENDING }),
    getHardReserveMinor(userId),
    getSoftReserves(userId),
  ]);
  const { forecast } = baseline;

  const simulation = simulatePurchasePlan({
    forecastInput: {
      asOf: forecast.asOf,
      horizonEnd: forecast.horizonEnd,
      balances: [{ accountId: "consolidated", amountMinor: forecast.openingBalanceMinor, observedAt: forecast.asOf }],
      events: forecast.events,
    },
    hardReserveMinor,
    softReserves: softReserves.map((reserve) => ({
      id: reserve.id,
      name: reserve.name,
      amountMinor: reserve.amountMinor,
    })),
    targetDate: plan.targetDate ?? undefined,
    items,
    cardActivity: cardActivityFor(baseline),
  });

  return { plan, simulation, baseline, unprojectedItems, inactiveItems, horizonDays };
}


/**
 * Every purchase registered on a card, newest first, with the installment plan
 * each one generated.
 *
 * Ownership is enforced on the card rather than the purchase: the purchase
 * table has no `userId` of its own, so reading it unscoped would cross tenants.
 */
export interface CardPurchaseFilter {
  /** Purchase date on or after (inclusive). */
  from?: string;
  /** Purchase date on or before (inclusive). */
  to?: string;
  /** Only purchases with a parcel still ahead (see `isRemainingParcel`). */
  openOnly?: boolean;
  /** Case-insensitive substring of the description or the merchant. */
  q?: string;
}

export async function listCardPurchases(userId: string, cardId: string, filter: CardPurchaseFilter = {}) {
  const card = await db.query.creditCards.findFirst({
    where: and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)),
    columns: { id: true },
  });
  if (!card) return [];

  const purchases = await db.query.creditCardPurchases.findMany({
    where: and(
      eq(creditCardPurchases.creditCardId, card.id),
      filter.from ? gte(creditCardPurchases.purchaseDate, filter.from) : undefined,
      filter.to ? lte(creditCardPurchases.purchaseDate, filter.to) : undefined,
    ),
    orderBy: [desc(creditCardPurchases.purchaseDate), asc(creditCardPurchases.id)],
    with: {
      transaction: { columns: { id: true, description: true, deletedAt: true } },
      installmentPlans: {
        columns: { id: true, totalInstallments: true, firstInstallmentNumber: true },
        with: {
          installments: {
            columns: { id: true, number: true, amountMinor: true, expectedAt: true, status: true, billingCycleId: true },
            orderBy: [asc(installments.number)],
          },
        },
      },
    },
  });

  const today = todayIso();
  const needle = filter.q?.trim().toLocaleLowerCase();
  const withRemaining = purchases.map((purchase) => ({
    ...purchase,
    installmentPlans: purchase.installmentPlans.map((plan) => {
      const parcels = plan.installments.map((one) => ({ ...one, remaining: isRemainingParcel(one, today) }));
      const remaining = parcels.filter((one) => one.remaining);
      return {
        ...plan,
        installments: parcels,
        remainingCount: remaining.length,
        remainingTotalMinor: remaining.reduce((total, one) => total + one.amountMinor, 0),
        nextExpectedAt: remaining[0]?.expectedAt ?? null,
      };
    }),
  }));
  return withRemaining.filter((purchase) => {
    if (
      needle &&
      !purchase.transaction.description.toLocaleLowerCase().includes(needle) &&
      !(purchase.merchant ?? "").toLocaleLowerCase().includes(needle)
    ) {
      return false;
    }
    if (filter.openOnly) return purchase.installmentPlans.some((plan) => plan.remainingCount > 0);
    return true;
  });
}

/**
 * Whether a parcel is still ahead of the user.
 *
 * `projected` and `billed` say whether the charge exists yet; neither says
 * whether it is still owed. A parcel is owed until its statement falls due —
 * after that the statement has collected it, or, for a projected parcel no
 * charge ever matched, there is no future statement left for it to land on.
 * Counting either as remaining listed purchases from a year ago as still
 * being paid off.
 */
function isRemainingParcel(parcel: { status: string; expectedAt: string }, today: string): boolean {
  return (parcel.status === "projected" || parcel.status === "billed") && parcel.expectedAt >= today;
}

/** Archived cards, so the UI can offer them back. */
export async function listArchivedCreditCards(userId: string) {
  return db.query.creditCards.findMany({
    where: and(eq(creditCards.userId, userId), eq(creditCards.active, false)),
    orderBy: [asc(creditCards.name)],
  });
}

/**
 * Installments still ahead, grouped by the purchase that created them.
 *
 * These are shown alongside recurring transactions because that is how they
 * behave from the outside — a fixed amount landing every month until a known
 * end. They are not recurrences: the forecast already carries them through the
 * card's statement projection (PRD R4), so nothing here feeds the engine a
 * second time.
 */
export async function listOpenInstallmentPlans(userId: string) {
  const cards = await db.query.creditCards.findMany({
    where: eq(creditCards.userId, userId),
    columns: { id: true, name: true, currencyCode: true },
  });
  if (cards.length === 0) return [];
  const cardById = new Map(cards.map((card) => [card.id, card]));

  const purchases = await db.query.creditCardPurchases.findMany({
    where: inArray(
      creditCardPurchases.creditCardId,
      cards.map((card) => card.id),
    ),
    with: {
      transaction: { columns: { description: true } },
      installmentPlans: { with: { installments: true } },
    },
  });

  const today = todayIso();
  return purchases
    .flatMap((purchase) =>
      purchase.installmentPlans.map((plan) => {
        const remaining = plan.installments
          .filter((one) => isRemainingParcel(one, today))
          .sort((left, right) => left.expectedAt.localeCompare(right.expectedAt));
        // Projected parcels whose statement is already due with no charge ever
        // matched to them. Not remaining (see `isRemainingParcel`), and not
        // known to be paid either, so they are counted apart.
        const lapsed = plan.installments.filter(
          (one) => one.status === "projected" && one.expectedAt < today,
        );
        const next = remaining[0];
        const card = cardById.get(purchase.creditCardId)!;
        return {
          id: plan.id,
          cardId: purchase.creditCardId,
          cardName: card.name,
          currencyCode: card.currencyCode,
          description: purchase.transaction.description,
          merchant: purchase.merchant,
          totalInstallments: plan.totalInstallments,
          paidInstallments: plan.totalInstallments - remaining.length,
          remainingCount: remaining.length,
          lapsedCount: lapsed.length,
          nextNumber: next?.number ?? null,
          nextAmountMinor: next?.amountMinor ?? 0,
          nextExpectedAt: next?.expectedAt ?? null,
          lastExpectedAt: remaining[remaining.length - 1]?.expectedAt ?? null,
          remainingTotalMinor: remaining.reduce((total, one) => total + one.amountMinor, 0),
        };
      }),
    )
    .filter((plan) => plan.remainingCount > 0)
    .sort((left, right) => (left.nextExpectedAt ?? "").localeCompare(right.nextExpectedAt ?? ""));
}

/**
 * The statements of one card the forecast settles in the next `horizonDays`,
 * each with what it is made of — the same `buildUserForecastDetailed` run every
 * cash figure comes from, so the amounts are the forecast's own, not a second
 * computation that could drift from it. Budget card-share estimates billed on
 * the same statement are separate events (LOW confidence) and are reported
 * beside each statement, never inside its amount.
 */
export async function getUpcomingCardStatements(userId: string, cardId: string, horizonDays = 120) {
  const card = await db.query.creditCards.findFirst({
    where: and(eq(creditCards.id, cardId), eq(creditCards.userId, userId)),
    columns: { id: true },
  });
  if (!card) return null;

  const detailed = await buildUserForecastDetailed(userId, horizonDays);
  const budgetShare = new Map<string, number>();
  for (const event of detailed.budgetConsumption.events) {
    // budget:<budgetId>:<month>:card:<cardId>:<statementMonth>
    const parts = event.logicalKey.split(":");
    if (parts[3] !== "card" || parts[4] !== cardId) continue;
    const month = parts[5]!;
    budgetShare.set(month, (budgetShare.get(month) ?? 0) + Math.abs(event.amountMinor));
  }

  return {
    asOf: detailed.forecast.asOf,
    horizonEnd: detailed.forecast.horizonEnd,
    statements: detailed.cardStatements
      .filter((statement) => statement.cardId === cardId)
      .map((statement) => ({
        ...statement,
        budgetCardShareMinor: budgetShare.get(statement.statementMonth) ?? 0,
      })),
    debtUnplaced: detailed.cardDebtUnplaced.find((entry) => entry.cardId === cardId) ?? null,
  };
}
