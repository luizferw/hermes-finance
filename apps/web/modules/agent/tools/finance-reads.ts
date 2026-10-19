import "server-only";
import { z } from "zod";
import { formatMoney } from "@kosh/domain";
import { BUDGET_ESTIMATE_SOURCE } from "@hermes-finance/forecast";
import { listAccounts } from "@/modules/accounts/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import {
  buildUserForecastDetailed,
  getCardStatement,
  getHardReserveMinor,
  getPurchasePlan,
  getPurchasePlanImpact,
  getSafeToSpend,
  listArchivedCreditCards,
  listCardPurchases,
  listCreditCards,
  listFinancialReserves,
  listOpenInstallmentPlans,
  listPurchasePlans,
  monthBalances,
} from "@/modules/finance/queries";
import { getFutureView } from "@/modules/future/queries";
import type { ReadTool } from "../types";
import { read } from "./shared";

/* ── helpers (name lookups only; every figure is passed through untouched) ── */

async function accountNames(userId: string): Promise<Map<string, string>> {
  return new Map((await listAccounts(userId)).map((account) => [account.id, account.name]));
}

/** The labels the plan screen prints for each rejection code. */
const REJECTION_LABEL: Record<string, string> = {
  HARD_RESERVE_VIOLATED: "Breaks the protected reserve",
  NEGATIVE_BALANCE: "Drives the balance below zero",
  CREDIT_LIMIT_EXCEEDED: "Exceeds the card limit",
  DEADLINE_EXCEEDED: "Bought after it is needed",
};

type PlanTotalsSource = {
  budgetMinor: number | null;
  estimatedTotalMinor: number;
  remainingEstimateMinor: number;
  purchasedTotalMinor: number;
  overBudgetMinor: number | null;
  underBudgetMinor: number | null;
};

/** The figures the plan totals line shows, exactly as the query computed them. */
function planTotals(plan: PlanTotalsSource) {
  return {
    estimatedTotalMinor: plan.estimatedTotalMinor,
    budgetMinor: plan.budgetMinor,
    overBudgetMinor: plan.overBudgetMinor,
    underBudgetMinor: plan.underBudgetMinor,
    purchasedTotalMinor: plan.purchasedTotalMinor,
    remainingEstimateMinor: plan.remainingEstimateMinor,
  };
}

const PLAN_TOTALS_DOC =
  "Plan totals (the line under the plan name): estimatedTotalMinor = sum over items that are active and not cancelled of (actualPriceMinor if set, else estimatedPriceMinor); purchasedTotalMinor = the same sum restricted to items with status 'purchased'; remainingEstimateMinor = the rest ('still to buy', shown by the UI only when something was purchased); with a budget, overBudgetMinor = max(0, estimated − budget) and underBudgetMinor = max(0, budget − estimated) ('over' or 'left'); both are null when the plan has no budget. Items with isActive=false (set aside by the user) or status 'cancelled' count for nothing. All items are priced in the plan's own currency.";

type PlanItemSource = {
  id: string;
  name: string;
  priority: string;
  estimatedPriceMinor: number;
  actualPriceMinor: number | null;
  earliestPurchaseDate: string | null;
  deadline: string | null;
  status: string;
  isActive: boolean;
  purchaseDate: string | null;
  accountId: string | null;
  installments: number;
  notes?: string | null;
  paymentOptions: Array<{
    id: string;
    paymentMethod: string;
    cardId: string | null;
    cashPriceMinor: number | null;
    installments: number | null;
    installmentAmountMinor: number | null;
    totalCostMinor: number | null;
    firstPaymentDate: string | null;
  }>;
};

function planItem(item: PlanItemSource, names: Map<string, string>) {
  return {
    id: item.id,
    name: item.name,
    priority: item.priority,
    estimatedPriceMinor: item.estimatedPriceMinor,
    actualPriceMinor: item.actualPriceMinor,
    earliestPurchaseDate: item.earliestPurchaseDate,
    deadline: item.deadline,
    status: item.status,
    isActive: item.isActive,
    purchaseDate: item.purchaseDate,
    accountId: item.accountId,
    accountName: item.accountId ? (names.get(item.accountId) ?? null) : null,
    installments: item.installments,
    notes: item.notes ?? null,
    paymentOptions: item.paymentOptions.map((option) => ({
      id: option.id,
      method: option.paymentMethod,
      cardId: option.cardId,
      cashPriceMinor: option.cashPriceMinor,
      installments: option.installments,
      installmentAmountMinor: option.installmentAmountMinor,
      totalCostMinor: option.totalCostMinor,
      firstPaymentDate: option.firstPaymentDate,
    })),
  };
}

/* ── methodology (sourced from docs/DOMAIN.md, docs/PRD.md and the code) ─── */

export const METHODOLOGY = {
  overview:
    "Every number comes from a deterministic engine over integer minor units (e.g. cents) plus an ISO 4217 currency. Tools pass the engine's output through; they never compute balances, forecasts, instalments or safe-to-spend themselves (PRD R6). Divide a *Minor value by 10^exponent of its currency (2 for most, 0 for JPY, 3 for KWD) to get major units. Inputs named `amount` are major units.",
  precedenceOfTruth: {
    order: "ACTUAL > CONFIRMED > HIGH > MEDIUM > LOW (PRD R1: real > confirmed future > fixed rule > historical estimate > manual estimate).",
    rule: "The forecast keeps only the highest-confidence event per logicalKey (tie: lowest id). An event with resolvedByTransactionId has been settled by a real transaction and leaves the active projection (R2/R3), so an estimate and the confirmed bill, or a real and a projected parcel, never both count.",
    confidenceBySource: [
      "Persisted projected events: the confidence stored with them.",
      "Fixed bill: HIGH. Variable bill: MEDIUM when the amount comes from the last transaction that actually paid it, LOW while only the typed estimate exists (PRD §9.10).",
      "Recurring rule: HIGH.",
      "Card statement: HIGH, or CONFIRMED once the real statement total is recorded (one cash event per cycle carries one confidence; a card-charged bill's own confidence is folded into it).",
      "Budget estimate: LOW (a manual estimate).",
      "Purchase simulation settlements: CONFIRMED (they are the hypothesis being tested).",
    ],
  },
  balancesAndPosition: {
    tools: ["get_position", "get_accounts"],
    rules: [
      "Only liquid accounts count toward the consolidated cash position: types asset, cash and wallet, not archived.",
      "Per account the latest balance snapshot on or before today wins (an external observation of the bank balance); without one, the ledger's currentBalanceMinor is used (source 'ledger').",
      "Staleness is a property of the source: a snapshot older than 3 days (2 days for Open Finance/pluggy, which refreshes daily) is stale. Ledger-derived balances are never flagged stale. Stale balances are still used but must be disclosed (PRD R8, §62) — tools return staleAccountNames.",
      "All balances are normalized to today as the forecast's opening balance.",
    ],
  },
  dailyForecast: {
    tools: ["get_projection", "get_projected_commitments", "get_budget_forecast"],
    rules: [
      "Opening balance = sum of liquid account positions. Each day: closing = opening + inflows − outflows; the minimum balance is measured over daily closings, never the opening balance (the opening is what today's spending comes out of).",
      "Signed events: inflow positive, outflow negative. Transfers between own accounts are excluded (they net to zero, R5).",
      "Card purchases are not cash events; only the statement settlement is (R4).",
    ],
    sources: [
      "1. Persisted projected events (projected_events), with their own logicalKey and confidence.",
      "2. Active bills in the default currency paid from a non-card account: one event per occurrence of the recurrence starting at nextDueDate, logicalKey recurring:bill:<id>:<date>. A bill charged to a card account is not projected on its due date; it is folded into the statement of the cycle open on that date.",
      "3. Active recurring transactions (not transfers) in the default currency, logicalKey recurring:rule:<id>:<date>.",
      "4. Card statements (see cardStatements), logicalKey statement:<cardId>:<YYYY-MM>, label 'Fatura <card>'.",
      "5. Budget estimates (scenario 'budget' only), sourceType budget_estimate, logicalKey budget:<budgetId>:<month>:cash:<date> or budget:<budgetId>:<month>:card:<cardId>:<statementMonth>, label 'Estimated spending · <budget>'.",
    ],
    labels: "Each event's human label is the bill / recurring rule name, 'Fatura <card>' for statements, 'Estimated spending · <budget>' for estimates, or the persisted event's eventType; otherwise its sourceType.",
  },
  cardStatements: {
    tools: ["get_card_statement", "get_credit_cards", "get_card_purchases", "get_open_installment_plans"],
    rules: [
      "One cash event per billing cycle on its dueAt, never one per parcel; parcels only feed the cycle total and the limit usage (R3/R4).",
      "Which statement a charge lands on is decided by nominalCycleFor(date, closingDay, dueDay): a purchase after the closing day belongs to the next cycle. Recorded cycles (credit_card_billing_cycles) override the nominal ones whenever they exist; paid recorded cycles leave the forecast.",
      "A card without recorded cycles (e.g. imported from a bank export) gets cycles derived from its ledger transactions by the same nominal rule (source 'derived'). A derived cycle's total is its charges only; payments posted inside the period are reported as creditsMinor beside it, because a payment usually settles the previous statement. Derived status is 'open' until its closing day, then 'closed' — never 'paid' (that is reconciliation, PRD §29).",
      "What the card still owes today (minus the card ledger account balance) is allocated across derived statements still ahead (allocateCardDebt). Debt that fits no statement ahead is reported as cardDebtUnplaced rather than dropped — usually future parcels the provider already counts, on a card in arrears a real understatement.",
      "Projected (not yet billed) instalments are added to the statement that falls due on their expected date; billed parcels are already ledger transactions and are not added again.",
      "Cycle source: 'recorded' (typed by the user), 'open_finance' (total confirmed by the institution), 'derived' (inferred from transactions). isReconciled = a confirmed total exists.",
      "Card committed (get_credit_cards) = max(0, −card account balance): the full outstanding debt including future instalments; available = limit − committed; utilization = round(committed / limit × 100).",
    ],
  },
  budgetEstimates: {
    tools: ["get_budget_forecast", "get_projection", "get_safe_to_spend"],
    rules: [
      "A budget is intention, not forecast (PRD §8): it never enters as itself. What enters is what is left of it in each month the horizon touches.",
      "remaining = max(0, planned − spent − committed), per budget per month.",
      "planned: the budget period amount for the month; a month without one reuses the latest earlier period.",
      "spent: expense transactions already in the ledger in the budget's categories (statuses imported/reviewed/posted, default currency, not deleted), any account.",
      "committed: what the forecast already carries in those categories later this month — bills (including card-charged bills, counted on their due date), recurring rules, persisted events with a category, and projected card parcels of purchases whose parcels the ledger books one by one (counted in their statement's month). A hand-entered card purchase is one full-value transaction already in spent, so its parcels are not committed again.",
      "The budget is the ceiling: history never raises the estimate, even when past spending exceeded the plan.",
      "Route mix: the share paid in cash vs each card comes from the categories' spending over the last 3 full months (largest-remainder split, basis points); with no recent spending it is all cash.",
      "Cash share: spread across the remaining days of the month. Card share: leaves on the due date of the statement open on the day it would be spent, as a separate event (not merged into the statement, so a guess never borrows the statement's confidence). The card share also counts against the card's limit (see cardLimit).",
      "Confidence: LOW.",
      "A category in two budgets blocks both (CATEGORY_IN_MULTIPLE_BUDGETS) rather than counting twice. Spending in categories without a budget, and purchase plan items, do not consume budgets.",
      "Scenarios: 'budget' (default for every user-facing number) includes the estimates; 'none' is commitments only, shown to reveal how much of an answer rests on the estimate.",
    ],
  },
  safeToSpend: {
    tools: ["get_safe_to_spend"],
    rules: [
      "hardReserveMinor = sum of active hard reserves (get_financial_reserves). The floor is the hard reserve, which is 0 when none is configured.",
      "For each route (cash, and each active card): settlementDate = today for cash; for a card, the due date of the statement open today (a purchase today is paid then). Room = lowest projected daily closing on or after settlementDate − hard reserve. Only the trough after the settlement counts, which is why a card can absorb what cash cannot. A settlement past the horizon falls back to the horizon's own trough.",
      "Headline safeToSpendMinor = the best route's room (bestOption). It may be negative: the forecast already lands that far below the floor before anything new is bought.",
      "safeToSpendByScenario gives the headline under 'budget' and 'none'; estimatedVariableMinor is the budget estimate's outflow inside committedMinor (all projected outflows).",
      "The engine's pure safe-to-spend (used inside simulations) is max(0, minimum balance − hard reserve): spending exactly it never breaches the reserve, spending one more unit does; the unclamped value is the 'surplus'.",
    ],
  },
  monthlyOutlook: {
    tools: ["get_budget_forecast", "get_purchase_plan_impact"],
    rules: [
      "Per calendar month of the forecast: closingBalanceMinor = the last day's closing, lowMinor/lowDate = the lowest daily closing and its date. A month can close fine and still dip below zero mid-month; both are reported.",
      "estimatedVariableMinor = the budget estimates' remaining for that month, already inside the figures.",
    ],
  },
  purchaseSimulation: {
    tools: ["simulate_purchase", "compare_payment_options", "get_purchase_plan_impact", "recommend_purchase_plan"],
    rules: [
      "Before and after are measured on the same forecast (scenario 'budget'), so the difference is the purchase alone.",
      "Settlements: a non-card payment settles in full on the purchase date. A card payment settles one instalment per statement, on the due dates of the recorded cycles from the purchase's nominal cycle onward, falling back to nominal cycle due dates. Instalments are split evenly; the last absorbs the remainder so they sum to the total exactly.",
      "Plan items are projected only when they are active and have both an account and a purchase date; a credit-card account makes it a card item over item.installments, any other account a single cash settlement. Items missing either are listed as unprojectedItems. The plan uses estimatedPriceMinor.",
      "The plan horizon is at least 365 days, stretched to the end of the month of the last settlement.",
      "Hard constraints, in order (PRD §22): NEGATIVE_BALANCE (trough after < floor 0), HARD_RESERVE_VIOLATED (trough after < hard reserve), CREDIT_LIMIT_EXCEEDED (card peak usage > limit), DEADLINE_EXCEEDED (purchase date after the item's deadline or the plan's target date; instalments running past it are fine). feasible = no rejection.",
      "Soft reserves only warn: softReserveImpacts lists each active soft reserve the after-trough falls below, with shortfall = reserve − trough.",
      "reasons are deterministic sentences with raw minor-unit numbers; quote them, do not recompute.",
    ],
    cardLimit:
      "Card limits are judged by peak usage over the horizon, not by the sum of charges. Usage at the end of a day = max(0, what the card owes today − statements paid so far) + every charge made and not yet settled (budget card share included). An instalment purchase blocks the whole amount on the purchase day and frees each instalment on the due date of the statement billing it. Items in a plan share the limit. Reported per card: committedMinor (today), baselinePeakMinor/Date (without), peakMinor/Date (with), planChargedMinor, exceededMinor = max(0, peak − limit).",
  },
  comparatorAndRecommender: {
    tools: ["compare_payment_options", "recommend_purchase_plan"],
    rules: [
      "compare_payment_options ranks feasible options by: lowest total cost → highest minimum balance → lowest peak monthly outflow → earliest last payment → lowest soft-reserve shortfall → id. Status OK / NO_FEASIBLE_OPTION (every option breaks a hard constraint; blockers say which) / INSUFFICIENT_DATA. Without a recommendation say so; never invent one.",
      "recommend_purchase_plan goes item by item, earliest deadline first, then most expensive, then id; per item it prefers the candidate leaving the highest trough → lowest peak monthly outflow → lowest total cost → fewest instalments → id, checking card limits against what earlier choices already occupy. When the forecast is already below the floor before buying, the bar becomes 'do not make it worse'. When nothing fits it still returns the least-bad choice, labelled fits=false, with blockedItems.",
    ],
  },
  confidenceBreakdown: {
    tools: ["get_confidence_breakdown"],
    rules: [
      "Sum of |amount| of every active forecast event in the horizon, grouped by confidence, plus each level's rounded share of the total (0–100). Measures how much of the projection rests on facts versus assumptions (PRD §61).",
    ],
  },
  goalsAndCommitments: {
    tools: ["get_future_view", "get_goals"],
    rules: [
      "See get_future_view's description for goal pace, status and monthly-needed formulas, and how committed monthly is normalized.",
    ],
  },
} as const;

/* ── tools ──────────────────────────────────────────────────────────────── */

export const financeReadsTools: ReadTool[] = [
  read({
    name: "get_methodology",
    title: "How the numbers are calculated",
    description:
      "Structured explanation of every calculation the finance tools return: precedence of truth and confidence levels, balances and staleness, the daily forecast and its sources, card statements, budget estimates, safe-to-spend, monthly outlook, purchase simulations and plans (verdict, hard reserve, floor, soft reserves, card peak usage), the comparator and recommender ranking, and the confidence breakdown. Read it whenever you need to explain how a figure was reached. No input.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute() {
      return { forModel: METHODOLOGY };
    },
  }),

  read({
    name: "get_safe_to_spend",
    title: "Safe to spend",
    description:
      "Room to spend today, exactly as the overview card shows it. For each route — cash ('À vista', settles today) and each active credit card (settles on the due date of the statement open today, since a card purchase today is paid then) — amountMinor = lowest projected daily closing balance on or after that route's settlementDate minus the hard reserve (floorMinor = sum of active hard reserves, 0 when none). Only the trough after the settlement counts, so a card can absorb what cash cannot. The headline safeToSpendMinor is the best route (bestOption); options are sorted best first. It can be negative: the forecast already lands that far below the floor before anything is bought. minimumBalanceMinor/Date is the horizon's overall trough. The forecast (default 30 days) includes what each budget still allows this month and next (scenario 'budget', LOW-confidence estimate, the budget is the ceiling); estimatedVariableMinor is that estimate's share of committedMinor (all projected outflows), and safeToSpendByScenario.none is the room if nothing beyond commitments were spent. staleAccountNames lists balances older than the freshness policy — say so when answering.",
    requiredScope: "finance:read",
    input: z.object({
      horizonDays: z.number().int().min(1).max(365).default(30),
      scenario: z.enum(["none", "budget"]).optional(),
    }),
    async execute(ctx, args) {
      const result = await getSafeToSpend(ctx.userId, args.horizonDays, args.scenario);
      return {
        forModel: {
          currency: ctx.currency,
          asOf: result.forecast.asOf,
          horizonEnd: result.forecast.horizonEnd,
          scenario: result.scenario,
          safeToSpendMinor: result.safeToSpendMinor,
          bestOption: result.bestOption,
          options: result.options.map((option) => ({
            ...option,
            isBest:
              option.cardId === result.bestOption.cardId && option.label === result.bestOption.label,
          })),
          floorMinor: result.floorMinor,
          hardReserveMinor: result.hardReserveMinor,
          hardReserveViolated: result.hardReserveViolated,
          minimumBalanceMinor: result.minimumBalanceMinor,
          minimumBalanceDate: result.minimumBalanceDate,
          committedMinor: result.committedMinor,
          estimatedVariableMinor: result.estimatedVariableMinor,
          safeToSpendByScenario: result.safeToSpendByScenario,
          staleAccountNames: result.staleAccountNames,
        },
        block: {
          type: "safeToSpend",
          title: "Safe to spend",
          period: `${result.forecast.asOf} to ${result.forecast.horizonEnd}`,
          safeMinor: result.safeToSpendMinor,
          incomeMinor: result.forecast.events
            .filter((event) => event.amountMinor > 0)
            .reduce((total, event) => total + event.amountMinor, 0),
          expenseMinor: result.committedMinor,
          committedMinor: result.committedMinor,
          currency: ctx.currency,
          note:
            `Best on ${result.bestOption.label}, leaving ${result.bestOption.settlementDate}. ` +
            `Minimum projected balance ${formatMoney(result.minimumBalanceMinor, ctx.currency)} on ${result.minimumBalanceDate}.` +
            (result.staleAccountNames.length > 0
              ? ` Uses a balance that is a few days old for ${result.staleAccountNames.join(", ")}.`
              : ""),
        },
      };
    },
  }),

  read({
    name: "get_projection",
    title: "Cash projection",
    description:
      "Deterministic daily cash forecast over the horizon (default 30 days): opening balance (sum of liquid accounts), the minimum daily closing balance and its date, every day's opening/inflows/outflows/closing, and every projected event with its human `label` (what the forecast chart tooltip shows: bill or recurring rule name, 'Fatura <card>' for a card statement, 'Estimated spending · <budget>' for a budget estimate). Sources: persisted projected events, bills paid from bank accounts, recurring rules, and one settlement per card statement on its due date (card purchases and card-charged bills appear only through their statement, never on their own). Balances include what each budget still allows (scenario 'budget' by default, 'none' on request); those estimates are summarized per budget in budgetEstimates and left out of days/events unless includeEstimateEvents=true (default false). Each event carries sourceType, confidence and logicalKey; see get_methodology for the rules.",
    requiredScope: "finance:read",
    input: z.object({
      horizonDays: z.number().int().min(1).max(365).default(30),
      scenario: z.enum(["none", "budget"]).optional(),
      includeEstimateEvents: z.boolean().optional(),
    }),
    async execute(ctx, args) {
      const { forecast, scenario, budgetConsumption, labels, cardDebtUnplaced, position } =
        await buildUserForecastDetailed(
          ctx.userId,
          args.horizonDays,
          args.scenario ? { variableSpending: args.scenario } : {},
        );
      const keep = (event: { sourceType: string }) =>
        args.includeEstimateEvents || event.sourceType !== BUDGET_ESTIMATE_SOURCE;
      const labelled = <E extends { logicalKey: string; sourceType: string }>(event: E) => ({
        ...event,
        label: labels.get(event.logicalKey) ?? event.sourceType,
      });
      return {
        forModel: {
          asOf: forecast.asOf,
          horizonEnd: forecast.horizonEnd,
          currency: ctx.currency,
          scenario,
          openingBalanceMinor: forecast.openingBalanceMinor,
          minimumBalanceMinor: forecast.minimumBalanceMinor,
          minimumBalanceDate: forecast.minimumBalanceDate,
          days: forecast.days.map((day) => ({ ...day, events: day.events.filter(keep).map(labelled) })),
          events: forecast.events.filter(keep).map(labelled),
          budgetEstimates:
            scenario === "none"
              ? []
              : budgetConsumption.estimates.map((estimate) => ({
                  budget: budgetConsumption.budgetNames.get(estimate.budgetId) ?? estimate.budgetId,
                  month: estimate.month,
                  remainingMinor: estimate.remainingMinor,
                })),
          cardDebtUnplaced,
          staleAccountNames: position.staleAccountNames,
        },
      };
    },
  }),

  read({
    name: "get_credit_cards",
    title: "Credit cards",
    description:
      "Active credit cards as the Cards screen shows them: limit, committed, available and utilization, plus closing/due days, the linked card ledger account and the payment (paid-from) account. committedMinor = max(0, −card ledger account balance), i.e. the full outstanding debt including future instalments already purchased; scheduledInstallmentsMinor is how much of it is scheduled as projected/billed instalments from today on; availableLimitMinor = limit − committed (can be negative); utilizationPercent = round(committed / limit × 100), 0 when the limit is 0. Archived cards: get_archived_credit_cards.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [cards, names] = await Promise.all([listCreditCards(ctx.userId), accountNames(ctx.userId)]);
      return {
        forModel: {
          cards: cards.map((card) => ({
            id: card.id,
            name: card.name,
            issuer: card.issuer,
            currency: card.currencyCode,
            creditLimitMinor: card.creditLimitMinor,
            committedMinor: card.committedMinor,
            scheduledInstallmentsMinor: card.scheduledInstallmentsMinor,
            availableLimitMinor: card.availableLimitMinor,
            utilizationPercent: card.utilizationPercent,
            defaultClosingDay: card.defaultClosingDay,
            defaultDueDay: card.defaultDueDay,
            accountId: card.accountId,
            accountName: card.account?.name ?? null,
            paymentAccountId: card.paymentAccountId,
            paymentAccountName: card.paymentAccountId ? (names.get(card.paymentAccountId) ?? null) : null,
          })),
        },
      };
    },
  }),

  read({
    name: "get_archived_credit_cards",
    title: "Archived credit cards",
    description:
      "Credit cards the user archived (shown at the bottom of the Cards screen so they can be restored). Archived cards take no part in the forecast, safe-to-spend or simulations.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [cards, names] = await Promise.all([listArchivedCreditCards(ctx.userId), accountNames(ctx.userId)]);
      return {
        forModel: {
          cards: cards.map((card) => ({
            id: card.id,
            name: card.name,
            issuer: card.issuer,
            currency: card.currencyCode,
            creditLimitMinor: card.creditLimitMinor,
            defaultClosingDay: card.defaultClosingDay,
            defaultDueDay: card.defaultDueDay,
            accountId: card.accountId,
            accountName: names.get(card.accountId) ?? null,
            paymentAccountId: card.paymentAccountId,
            paymentAccountName: card.paymentAccountId ? (names.get(card.paymentAccountId) ?? null) : null,
          })),
        },
      };
    },
  }),

  read({
    name: "get_card_statement",
    title: "Card statement",
    description:
      "Statement history of one credit card (active or archived), newest first, as the card screen shows it, plus the card's closing/due days and payment (paid-from) account. Recorded cycles win over derived ones for the same month. source: 'recorded' (typed), 'open_finance' (total confirmed by the institution), 'derived' (inferred from the card's ledger transactions using its closing/due days — not a confirmed statement; say so). totalMinor = confirmed total when reconciled, else charges (for derived cycles, charges only: payments posted inside the period are reported in creditsMinor, 'paid or refunded', because a payment usually settles the previous statement). status of a derived cycle is 'open' until its closing date, then 'closed'; it never becomes 'paid' from dates alone. Registered purchases: get_card_purchases.",
    requiredScope: "finance:read",
    input: z.object({ cardId: z.string().uuid() }),
    async execute(ctx, args) {
      const statement = await getCardStatement(ctx.userId, args.cardId);
      if (!statement) return { forModel: { error: "not_found" } };
      const { card } = statement;
      const names = await accountNames(ctx.userId);
      return {
        forModel: {
          card: {
            id: card.id,
            name: card.name,
            issuer: card.issuer,
            currency: card.currencyCode,
            creditLimitMinor: card.creditLimitMinor,
            defaultClosingDay: card.defaultClosingDay,
            defaultDueDay: card.defaultDueDay,
            active: card.active,
            accountId: card.accountId,
            accountName: names.get(card.accountId) ?? null,
            paymentAccountId: card.paymentAccountId,
            paymentAccountName: card.paymentAccountId ? (names.get(card.paymentAccountId) ?? null) : null,
          },
          cycles: statement.cycles.map((cycle) => ({
            id: cycle.id,
            statementMonth: cycle.statementMonth,
            closesAt: cycle.closesAt,
            dueAt: cycle.dueAt,
            status: cycle.status,
            chargesMinor: cycle.chargesMinor,
            creditsMinor: cycle.creditsMinor,
            totalMinor: cycle.totalMinor,
            isReconciled: cycle.isReconciled,
            source: cycle.source,
          })),
        },
      };
    },
  }),

  read({
    name: "get_card_purchases",
    title: "Card purchases",
    description:
      "Purchases registered on one credit card, newest first (the 'Registered purchases' list): purchase date, description (of the linked transaction), merchant, total, category, number of instalments, and each instalment plan's rows (number, amount, expected date = the due date of the statement billing it, status projected/billed/paid/cancelled, billing cycle). Only 'projected' rows are added to future statements by the forecast; 'billed' ones are already ledger transactions. transactionDeleted=true means the linked transaction was soft-deleted from the transactions screen while its instalments remain.",
    requiredScope: "finance:read",
    input: z.object({ cardId: z.string().uuid() }),
    async execute(ctx, args) {
      const [active, archived] = await Promise.all([
        listCreditCards(ctx.userId),
        listArchivedCreditCards(ctx.userId),
      ]);
      const card = [...active, ...archived].find((candidate) => candidate.id === args.cardId);
      if (!card) return { forModel: { error: "not_found" } };
      const [purchases, categories] = await Promise.all([
        listCardPurchases(ctx.userId, card.id),
        listCategories(ctx.userId),
      ]);
      const categoryName = new Map(categories.map((category) => [category.id, category.name]));
      return {
        forModel: {
          card: { id: card.id, name: card.name, currency: card.currencyCode },
          purchases: purchases.map((purchase) => ({
            id: purchase.id,
            purchaseDate: purchase.purchaseDate,
            description: purchase.transaction.description,
            merchant: purchase.merchant,
            totalAmountMinor: purchase.totalAmountMinor,
            categoryId: purchase.categoryId,
            categoryName: purchase.categoryId ? (categoryName.get(purchase.categoryId) ?? null) : null,
            transactionId: purchase.transaction.id,
            transactionDeleted: purchase.transaction.deletedAt !== null,
            totalInstallments: purchase.installmentPlans[0]?.totalInstallments ?? null,
            installmentPlans: purchase.installmentPlans.map((plan) => ({
              id: plan.id,
              totalInstallments: plan.totalInstallments,
              firstInstallmentNumber: plan.firstInstallmentNumber,
              installments: plan.installments.map((row) => ({
                number: row.number,
                amountMinor: row.amountMinor,
                expectedAt: row.expectedAt,
                status: row.status,
                billingCycleId: row.billingCycleId,
              })),
            })),
          })),
        },
      };
    },
  }),

  read({
    name: "get_open_installment_plans",
    title: "Open instalment plans",
    description:
      "Card purchases still being paid off (the 'Installments' list on the recurring screen), soonest next instalment first. Per plan: card, description, merchant, totalInstallments, paidInstallments = total − remaining, remainingCount = instalments with status projected or billed, nextAmountMinor/nextExpectedAt = the earliest remaining one, lastExpectedAt = the latest remaining one, remainingTotalMinor = sum of the remaining. The UI badge reads '(paid+1)/total'. These are already in the forecast through each card's statement; they are not recurrences and are not counted again.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const plans = await listOpenInstallmentPlans(ctx.userId);
      return {
        forModel: {
          plans: plans.map((plan) => ({ ...plan, currency: plan.currencyCode })),
        },
      };
    },
  }),

  read({
    name: "get_financial_reserves",
    title: "Financial reserves",
    description:
      "Every reserve configured (the Reserves screen), active first: name, kind, amount, currency, active. Hard reserves: the active ones are summed (activeHardReserveMinor) into the floor that safe-to-spend measures room against and that a purchase simulation must never cross (HARD_RESERVE_VIOLATED). Soft reserves never reject anything; a simulation only warns (softReserveImpacts) when its lowest projected balance falls below one, with the shortfall. Inactive reserves are ignored.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [reserves, activeHardReserveMinor] = await Promise.all([
        listFinancialReserves(ctx.userId),
        getHardReserveMinor(ctx.userId),
      ]);
      return {
        forModel: {
          activeHardReserveMinor,
          currency: ctx.currency,
          reserves: reserves.map((reserve) => ({
            id: reserve.id,
            name: reserve.name,
            kind: reserve.kind,
            amountMinor: reserve.amountMinor,
            currency: reserve.currencyCode,
            isActive: reserve.isActive,
          })),
        },
      };
    },
  }),

  read({
    name: "get_future_view",
    title: "Future view",
    description:
      "The goals and commitments part of the /plan (Future) screen. goalsActive = goals not achieved; goalsRemainingMinor = sum of remaining over non-achieved goals in the default currency. committedMonthlyMinor = recurringMonthlyMinor + billsMonthlyMinor, where each active expense recurring rule and each active bill in the default currency is normalized to a month (weekly × 52/12, monthly × 1, quarterly × 1/3, yearly × 1/12; rounded); committedCount is how many of them. Goal trajectories (sorted behind, on_pace, open, achieved; then soonest target): ratio = current / target (capped at 1); remaining = max(0, target − current); pace = where the goal should be by now on a straight line from the goal's creation to its target date, clamp((now − created) / (target − created), 0, 1) (1 if the target is not after creation; null without a target date); status = achieved if marked achieved or ratio ≥ 1, open without a target date, on_pace if ratio ≥ 0.9 × pace, else behind; behindMinor = round((pace − ratio) × target), only when behind; daysLeft = days from today to the target date; monthlyNeededMinor = round(remaining / monthsLeft) with monthsLeft = max(0, daysLeft / 30.44), or the whole remaining when less than a month is left (null when achieved or undated) — shown as '/mo to catch up' when behind, '/mo keeps you on track' when on pace. upcomingBills = active bills (any currency) overdue or due within 45 days, soonest first, at most 8; amounts are the bill's typed expected amount. The other /plan sections are get_position, get_budget_forecast (monthly outlook), get_projection (chart) and get_confidence_breakdown.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const view = await getFutureView(ctx.userId);
      return {
        forModel: {
          currency: ctx.currency,
          goalsActive: view.goalsActive,
          goalsRemainingMinor: view.goalsRemainingMinor,
          committedMonthlyMinor: view.committedMonthlyMinor,
          recurringMonthlyMinor: view.recurringMonthlyMinor,
          billsMonthlyMinor: view.billsMonthlyMinor,
          committedCount: view.committedCount,
          goals: view.goals.map((goal) => ({ ...goal, currency: goal.currencyCode })),
          upcomingBills: view.upcomingBills.map(({ bill, state, daysUntilDue }) => ({
            id: bill.id,
            name: bill.name,
            nextDueDate: bill.nextDueDate,
            expectedAmountMinor: Math.abs(bill.expectedAmountMinor),
            currency: bill.currencyCode,
            amountStrategy: bill.amountStrategy,
            recurrence: bill.recurrence,
            state,
            daysUntilDue,
            accountName: bill.account?.name ?? null,
            categoryName: bill.category?.name ?? null,
          })),
        },
      };
    },
  }),

  read({
    name: "get_purchase_plans",
    title: "Purchase plans",
    description: `All purchase plans with their totals, items (with account names) and stored payment options. ${PLAN_TOTALS_DOC} For what a plan does to the cash horizon use get_purchase_plan_impact.`,
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [plans, names] = await Promise.all([listPurchasePlans(ctx.userId), accountNames(ctx.userId)]);
      return {
        forModel: {
          currency: ctx.currency,
          plans: plans.map((plan) => ({
            id: plan.id,
            name: plan.name,
            description: plan.description,
            targetDate: plan.targetDate,
            currency: plan.currencyCode,
            status: plan.status,
            totals: planTotals(plan),
            items: plan.items.map((item) => planItem(item, names)),
          })),
        },
      };
    },
  }),

  read({
    name: "get_purchase_plan",
    title: "Purchase plan",
    description: `Full detail of one purchase plan by id: totals, items (with account names), payment options, and stored simulations. ${PLAN_TOTALS_DOC} For the live impact on the horizon (verdict, balances, card load, month by month) use get_purchase_plan_impact.`,
    requiredScope: "finance:read",
    input: z.object({ id: z.string().uuid() }),
    async execute(ctx, args) {
      const [plan, names] = await Promise.all([getPurchasePlan(ctx.userId, args.id), accountNames(ctx.userId)]);
      if (!plan) return { forModel: { error: "not_found" } };
      return {
        forModel: {
          currency: ctx.currency,
          plan: {
            id: plan.id,
            name: plan.name,
            description: plan.description,
            targetDate: plan.targetDate,
            currency: plan.currencyCode,
            status: plan.status,
            totals: planTotals(plan),
            items: plan.items.map((item) => ({
              ...planItem(item, names),
              simulations: item.simulations.map((sim) => ({
                id: sim.id,
                paymentOptionId: sim.paymentOptionId,
                forecastVersion: sim.forecastVersion,
                currentBalanceMinor: sim.currentBalanceMinor,
                minimumBalanceMinor: sim.minimumBalanceMinor,
                safeToSpendBeforeMinor: sim.safeToSpendBeforeMinor,
                safeToSpendAfterMinor: sim.safeToSpendAfterMinor,
                reserveViolations: sim.reserveViolations,
                totalCostMinor: sim.totalCostMinor,
                lastInstallmentDate: sim.lastInstallmentDate,
                recommendationScore: sim.recommendationScore,
                createdAt: sim.createdAt,
              })),
            })),
          },
        },
      };
    },
  }),

  read({
    name: "get_purchase_plan_impact",
    title: "Purchase plan impact",
    description:
      "Everything the purchase plan screen shows: header and totals, items with account names, items left out of the projection, and what buying the whole basket does to the cash horizon. " +
      "Projection: only active items with both an account and a purchase date are projected (others are listed in unprojectedItems); each uses its estimatedPriceMinor. An item on a credit-card account is a card purchase in item.installments instalments, each settling on the due date of a successive statement of that card (recorded cycles from the purchase's cycle onward, else the nominal closing/due days); split evenly, the last absorbing the remainder. Any other account settles in full on the purchase date. " +
      "Baseline = the forecast without the plan, including what each budget still allows (scenario 'budget', LOW-confidence estimate) over a horizon of at least 365 days, stretched to the end of the month of the last settlement; after = the same forecast plus every item's settlements. " +
      "Verdict (feasible, rejections in order, reasons verbatim with raw minor units): NEGATIVE_BALANCE when the lowest balance after falls below the floor of 0; HARD_RESERVE_VIOLATED when it falls below the hard reserve (hardReserveMinor, sum of active hard reserves); CREDIT_LIMIT_EXCEEDED when a card's peak usage exceeds its limit; DEADLINE_EXCEEDED when an item is bought after its deadline or the plan's target date. " +
      "Card limit is judged by peak usage over the horizon: what the card owes today less statements paid so far (never below 0), plus every open charge — budget card share included, and each plan instalment from the purchase day until its statement is paid. cards[] gives per card committedMinor (today), baselinePeakMinor/Date (without the plan), peakMinor/Date (with it), planChargedMinor, creditLimitMinor, exceededMinor. " +
      "safeToSpendBefore/AfterMinor = max(0, lowest balance − hard reserve); safeToSpendSurplusBefore/AfterMinor are the same unclamped (negative = that far below the protected reserve). softReserveImpacts: soft reserves the after-trough falls below (warning only). monthlyOutlook: per month the plan's outflow with per-item instalment rows (n of total), lowest balance with date, and closing balance, after the plan. monthlyBalances: per month closing and lowest balance without vs with the plan. includeDaily=true adds the chart's daily closing balances before/after.",
    requiredScope: "finance:read",
    input: z.object({
      planId: z.string().uuid(),
      includeDaily: z.boolean().default(false),
    }),
    async execute(ctx, args) {
      const [impact, names, hardReserveMinor] = await Promise.all([
        getPurchasePlanImpact(ctx.userId, args.planId),
        accountNames(ctx.userId),
        getHardReserveMinor(ctx.userId),
      ]);
      if (!impact) return { forModel: { error: "not_found" } };
      const { plan, simulation, baseline, unprojectedItems } = impact;
      const currency = plan.currencyCode;

      const header = {
        id: plan.id,
        name: plan.name,
        description: plan.description,
        targetDate: plan.targetDate,
        currency,
        status: plan.status,
        totals: planTotals(plan),
      };
      const items = plan.items.map((item) => planItem(item, names));

      if (!simulation || !baseline) {
        return {
          forModel: {
            plan: header,
            items,
            unprojectedItems,
            simulation: null,
            note: "No active item has both an account and a purchase date, so nothing is projected yet.",
          },
        };
      }

      const before = monthBalances(baseline.forecast);
      const after = monthBalances(simulation.forecastAfter);
      const monthlyBalances = [...after.entries()].map(([month, withPlan]) => {
        const withoutPlan = before.get(month);
        return {
          month,
          withoutPlan: withoutPlan
            ? {
                closingBalanceMinor: withoutPlan.closingBalanceMinor,
                lowMinor: withoutPlan.lowMinor,
                lowDate: withoutPlan.lowDate,
              }
            : null,
          withPlan: {
            closingBalanceMinor: withPlan.closingBalanceMinor,
            lowMinor: withPlan.lowMinor,
            lowDate: withPlan.lowDate,
          },
        };
      });

      let daily: Array<{ date: string; beforeMinor: number; afterMinor: number }> | undefined;
      if (args.includeDaily) {
        const beforeByDate = new Map(baseline.forecast.days.map((day) => [day.date, day.closingBalanceMinor]));
        daily = simulation.forecastAfter.days.flatMap((day) => {
          const beforeMinor = beforeByDate.get(day.date);
          return beforeMinor === undefined ? [] : [{ date: day.date, beforeMinor, afterMinor: day.closingBalanceMinor }];
        });
      }

      return {
        forModel: {
          plan: header,
          items,
          unprojectedItems,
          scenario: baseline.scenario,
          asOf: baseline.forecast.asOf,
          horizonEnd: baseline.forecast.horizonEnd,
          staleAccountNames: baseline.position.staleAccountNames,
          cardDebtUnplaced: baseline.cardDebtUnplaced,
          verdict: {
            feasible: simulation.feasible,
            rejections: simulation.rejections,
            rejectionLabels: simulation.rejections.map((code) => REJECTION_LABEL[code] ?? code),
            reasons: simulation.reasons,
          },
          itemResults: simulation.items,
          totalCostMinor: simulation.totalCostMinor,
          lastPaymentDate: simulation.lastPaymentDate ?? null,
          hardReserveMinor,
          floorMinor: 0,
          minimumBalanceBeforeMinor: simulation.minimumBalanceBeforeMinor,
          minimumBalanceBeforeDate: simulation.minimumBalanceBeforeDate,
          minimumBalanceAfterMinor: simulation.minimumBalanceAfterMinor,
          minimumBalanceAfterDate: simulation.minimumBalanceAfterDate,
          hardReserveViolated: simulation.hardReserveViolated,
          safeToSpendBeforeMinor: simulation.safeToSpendBeforeMinor,
          safeToSpendAfterMinor: simulation.safeToSpendAfterMinor,
          safeToSpendSurplusBeforeMinor: simulation.safeToSpendSurplusBeforeMinor,
          safeToSpendSurplusAfterMinor: simulation.safeToSpendSurplusAfterMinor,
          softReserveImpacts: simulation.softReserveImpacts,
          cards: simulation.cards,
          monthlyImpactMinor: simulation.monthlyImpactMinor,
          monthlyOutlook: simulation.monthlyOutlook,
          monthlyBalances,
          ...(daily ? { daily } : {}),
        },
      };
    },
  }),
];
