import "server-only";
import { z } from "zod";
import {
  addMonthsClamped,
  formatMoney,
  majorToMinor,
  monthRange,
  todayIso,
} from "@kosh/domain";
import { getNetWorthSummary, listAccounts } from "@/modules/accounts/queries";
import {
  getMonthSummary,
  getMonthSummaryFor,
  getSpendingByCategory,
} from "@/modules/reports/queries";
import {
  listTransactions,
  getTransaction,
} from "@/modules/transactions/queries";
import { getUpcomingBills, listBills } from "@/modules/bills/queries";
import { listRecurring } from "@/modules/recurring/queries";
import { listGoals } from "@/modules/goals/queries";
import { listBudgetsWithProgress } from "@/modules/budgets/queries";
import { getPatternsView } from "@/modules/patterns/queries";
import {
  getBudgetForecast,
  getConfidenceBreakdown,
  getFinancePosition,
  getPurchaseItem,
  getPurchasePlan,
  getUpcomingCommitments as getProjectedCommitments,
} from "@/modules/finance/queries";
import {
  compareUserPaymentOptions,
  recommendUserPurchasePlan,
  simulateUserPurchase,
} from "@/modules/finance/simulation";
import { listCategories } from "@/modules/taxonomy/queries";
import {
  updateTransactionCore,
  approveTransactionsCore,
  bulkCategorizeCore,
} from "@/modules/transactions/mutations";
import {
  createPurchaseItemCore,
  createPurchasePlanCore,
  deletePurchaseItemCore,
  deletePurchasePlanCore,
  setPurchaseItemActiveCore,
  updatePurchaseItemCore,
  updatePurchasePlanCore,
} from "@/modules/finance/mutations";
import type {
  CreatePurchaseItemInput,
  CreatePurchasePlanInput,
  UpdatePurchaseItemInput,
  UpdatePurchasePlanInput,
} from "@/modules/finance/validators";
import {
  listRulesCore,
  setRuleActiveCore,
  runRuleCore,
} from "@/modules/rules/core";
import {
  currencyCodeInput,
  currencyWarningBlocks,
  formatMajor,
  isoDateSchema,
  monthIsoFor,
  monthLabel,
  read,
  resolveCategory,
  resolveNamedAccount,
  write,
} from "./tools/shared";
import { financeReadsTools } from "./tools/finance-reads";
import { financeWritesReadTools, financeWritesTools } from "./tools/finance-writes";
import { ledgerReadsTools } from "./tools/ledger-reads";
import {
  ledgerWritesTools,
  resolveRuleDefinition,
  RULE_SEMANTICS,
  ruleDefinitionInput,
  rulePreview,
} from "./tools/ledger-writes";
import type {
  ReadTool,
  WriteTool,
  Tool,
  ExecStatus,
  Scope,
} from "./types";

const periodSchema = z.enum(["this_month", "last_month"]).optional();

/* ── purchase simulation input (narrow surface over the deterministic engine
   in modules/finance/simulation.ts — the model supplies the option, the
   engine supplies every number in the response) ─────────────────────────── */


const purchaseOptionInput = z.object({
  id: z.string().min(1).max(100),
  label: z.string().max(150).optional(),
  method: z.enum(["pix", "boleto", "cash", "credit_card", "debit_card"]),
  amountMinor: z.number().int().positive(),
  cardId: z.string().uuid().nullish(),
  installments: z.number().int().min(1).max(60).nullish(),
  installmentAmountMinor: z.number().int().positive().nullish(),
  purchaseDate: isoDateSchema.nullish(),
  firstPaymentDate: isoDateSchema.nullish(),
});

const simulationContextInput = z
  .object({
    horizonDays: z.number().int().min(1).max(365).default(30),
    maxLastPaymentDate: isoDateSchema.optional(),
    scenario: z
      .enum(["none", "budget"])
      .optional()
      .describe("'budget' (default): the baseline includes what each budget still allows; 'none': commitments only"),
  })
  .default(() => ({ horizonDays: 30 }));

/* ── purchase plan recommendation input (shopping list, not persisted;
   the engine generates the candidates from the user's own cards) ────── */

const planRecommendationItemInput = z.object({
  label: z.string().min(1).max(150),
  /** Cash price of the item, in major units. */
  amount: z.number().positive(),
  neededBy: isoDateSchema.optional(),
  maxInstallments: z.number().int().min(1).max(60).optional(),
});

/* ── purchase plan writes (inputs mirror modules/finance/validators.ts;
   amounts arrive in major units and the xCore converts them against the
   plan's own currency, exactly as the UI forms do) ─────────────────────── */

const planStatusInput = z.enum(["active", "completed", "archived"]);

/* ── READ TOOLS ─────────────────────────────────────────────────────────── */

const readTools: ReadTool[] = [
  read({
    name: "get_financial_snapshot",
    title: "Financial snapshot",
    description:
      "Net worth, assets, liabilities, and this month's income/expense/net. Use for 'how am I doing' overview questions. Net worth is get_accounts' header: over non-archived accounts in the default currency with includeInNetWorth on, assets = sum of positive balances, liabilities = sum of negative balances as a positive figure, netWorth = assets − liabilities. The month figures follow compare_periods: income = positive income transactions, expense = negative expense transactions as a positive figure, net = income − expense, ledger statuses (imported, reviewed, posted) and default currency only, transfers excluded; the month is the current calendar month to date.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [nw, month] = await Promise.all([
        getNetWorthSummary(ctx.userId),
        getMonthSummary(ctx.userId),
      ]);
      const forModel = {
        netWorthMinor: nw.netWorthMinor,
        assetsMinor: nw.assetsMinor,
        liabilitiesMinor: nw.liabilitiesMinor,
        monthIncomeMinor: month.incomeMinor,
        monthExpenseMinor: month.expenseMinor,
        monthNetMinor: month.netMinor,
        currency: ctx.currency,
      };
      return {
        forModel,
        block: {
          type: "figure",
          title: "Net worth",
          figure: { label: "Net worth", amountMinor: nw.netWorthMinor, currency: ctx.currency },
          caption: `This month: kept ${formatMoney(month.netMinor, ctx.currency)}`,
        },
      };
    },
  }),

  read({
    name: "get_spending_breakdown",
    title: "Spending breakdown",
    description: `Spending grouped by category for one calendar month: this month (default), last month, or the month containing \`month\` (any yyyy-MM-dd date inside it; overrides period). What counts: transactions of type expense with a negative amount, dated inside the month, in a ledger status (imported, reviewed, posted — pending and rejected are excluded, as are deleted rows), in the user's default currency only (other currencies are excluded, not converted). Income, transfers, adjustments and opening balances never count, and refunds (positive expense rows) are not netted. Each row's spentMinor is the sum of those amounts as a positive figure, grouped by the transaction's own category ('Uncategorized' when it has none), largest first. totalMinor is the sum over every category — the same figure as compare_periods' expense and get_monthly_flows for that month. Up to \`limit\` categories are listed (default 8, max 100); the remainder is folded into one 'Other (N categories)' row so rows always add up to totalMinor, and truncated says whether that happened. categoryCount is how many categories had spending.`,
    requiredScope: "finance:read",
    input: z.object({
      period: periodSchema,
      month: isoDateSchema.optional().describe("any date inside the month (yyyy-MM-dd); overrides period"),
      limit: z.number().int().min(1).max(100).default(8),
    }),
    async execute(ctx, args) {
      const monthIso = args.month ?? monthIsoFor(args.period);
      const { start, end } = monthRange(monthIso);
      const spending = await getSpendingByCategory(ctx.userId, monthIso);
      const total = spending.reduce((s, c) => s + c.spentMinor, 0);
      const shown = spending.slice(0, args.limit);
      const rest = spending.slice(args.limit);
      const rows: Array<{ name: string; color: string | null; spentMinor: number; categoryId: string | null }> = shown.map(
        (c) => ({ name: c.name, color: c.color, spentMinor: c.spentMinor, categoryId: c.categoryId }),
      );
      if (rest.length > 0) {
        rows.push({
          name: `Other (${rest.length} ${rest.length === 1 ? "category" : "categories"})`,
          color: null,
          spentMinor: rest.reduce((s, c) => s + c.spentMinor, 0),
          categoryId: null,
        });
      }
      const title = args.month
        ? `Where it went · ${monthLabel(monthIso)}`
        : args.period === "last_month"
          ? "Where it went · last month"
          : "Where it went";
      return {
        forModel: {
          month: monthLabel(monthIso),
          from: start,
          to: end,
          totalMinor: total,
          categoryCount: spending.length,
          truncated: rest.length > 0,
          categories: rows,
          currency: ctx.currency,
        },
        block: {
          type: "breakdown",
          title,
          currency: ctx.currency,
          rows: rows.map(({ name, color, spentMinor }) => ({ name, color, spentMinor })),
          totalMinor: total,
        },
      };
    },
  }),

  read({
    name: "compare_periods",
    title: "Compare months",
    description:
      "Income, expense and net for this calendar month (to date, partial) versus the whole of last month. incomeMinor = sum of income transactions with a positive amount; expenseMinor = sum of expense transactions with a negative amount, as a positive figure; netMinor = income − expense. Only ledger statuses count (imported, reviewed, posted — pending, rejected and deleted rows are excluded), only the user's default currency (others excluded, not converted), and transfers between your own accounts, adjustments and opening balances never count. Refunds are not netted: a positive expense row is neither income nor a reduction of expense. These are the same month figures as get_financial_snapshot, get_monthly_flows and get_spending_breakdown's total.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const thisIso = todayIso();
      const lastIso = addMonthsClamped(thisIso, -1);
      const [a, b] = await Promise.all([
        getMonthSummaryFor(ctx.userId, lastIso),
        getMonthSummaryFor(ctx.userId, thisIso),
      ]);
      const label = (iso: string) =>
        new Intl.DateTimeFormat("en-IN", { month: "long" }).format(
          new Date(`${iso.slice(0, 7)}-01T00:00:00`),
        );
      return {
        forModel: { last: { ...a, label: label(lastIso) }, current: { ...b, label: label(thisIso) }, currency: ctx.currency },
        block: {
          type: "comparison",
          title: "This month vs last",
          currency: ctx.currency,
          a: { label: label(lastIso), ...a },
          b: { label: label(thisIso), ...b },
        },
      };
    },
  }),

  read({
    name: "get_upcoming_commitments",
    title: "Upcoming commitments",
    description: "Bills due (and overdue) within the next N days (default 30).",
    requiredScope: "finance:read",
    input: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    async execute(ctx, args) {
      const bills = await getUpcomingBills(ctx.userId, args.days);
      const rows = bills.slice(0, 12).map((b) => ({
        id: b.bill.id,
        name: b.bill.name,
        amountMinor: b.bill.expectedAmountMinor,
        currency: b.bill.currencyCode,
        dueDate: b.bill.nextDueDate,
        daysUntilDue: b.daysUntilDue,
        overdue: b.state === "overdue",
      }));
      return {
        forModel: { commitments: rows, currency: ctx.currency },
        block: { type: "commitments", title: "Coming up", currency: ctx.currency, rows },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "find_unusual_spending",
    title: "Unusual spending",
    description:
      "Find the largest category-level changes in spending this month (to date) versus the whole of last month — the Patterns page's 'What's shifting'. Spending per category is computed as in get_spending_breakdown (negative expense transactions, ledger statuses, default currency). For each category with spending in either month: currentMinor, priorMinor, deltaMinor = current − prior, deltaPct = round(delta / prior × 100) (null when there was no prior spend), isNew when there was none last month. Sorted by absolute delta, unchanged categories dropped, top `limit` (default 5). Because this month is partial, early in the month most categories read as down. A simple change heuristic, not fraud or anomaly detection.",
    requiredScope: "finance:read",
    input: z.object({ limit: z.number().int().min(1).max(8).default(5) }),
    async execute(ctx, args) {
      const patterns = await getPatternsView(ctx.userId);
      // category drift is a transparent heuristic; add transaction-level
      // seasonality only if users need real anomaly detection.
      const rows = patterns.drift
        .filter((row) => row.deltaMinor !== 0)
        .slice(0, args.limit)
        .map((row) => ({
          name: row.name,
          currentMinor: row.currentMinor,
          priorMinor: row.priorMinor,
          deltaMinor: row.deltaMinor,
          deltaPct: row.deltaPct,
          isNew: row.isNew,
        }));
      return {
        forModel: {
          currency: ctx.currency,
          method: "largest absolute category changes, current month versus prior month",
          changes: rows,
        },
        block: {
          type: "anomalies",
          title: "Largest spending changes",
          currency: ctx.currency,
          rows,
          note: "Category changes compared with last month. This highlights movement; it does not identify fraud.",
        },
      };
    },
  }),

  read({
    name: "list_missing_setup_items",
    title: "Missing setup",
    description:
      "List missing Kosh data that limits financial answers, such as accounts, transactions, budgets, bills, recurring items, or goals.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [accounts, txs, budgets, bills, recurring, goals] = await Promise.all([
        listAccounts(ctx.userId),
        listTransactions(ctx.userId, { page: 1, pageSize: 1 }),
        listBudgetsWithProgress(ctx.userId),
        listBills(ctx.userId),
        listRecurring(ctx.userId),
        listGoals(ctx.userId),
      ]);
      const items = [
        accounts.some((account) => !account.isArchived)
          ? null
          : { label: "Add an account", detail: "Balances and net worth need an account.", href: "/accounts" },
        txs.total > 0
          ? null
          : { label: "Import transactions", detail: "Spending and cashflow need ledger activity.", href: "/transactions/import" },
        budgets.length > 0
          ? null
          : { label: "Create a budget", detail: "Budget progress needs at least one budget.", href: "/plan/budgets" },
        bills.length > 0
          ? null
          : { label: "Track bills", detail: "Upcoming commitments need bill dates and amounts.", href: "/plan/bills" },
        recurring.length > 0
          ? null
          : { label: "Add recurring items", detail: "Recurring-spend answers need tracked schedules.", href: "/plan/recurring" },
        goals.length > 0
          ? null
          : { label: "Add a savings goal", detail: "Goal progress needs a target.", href: "/plan/goals" },
      ].filter((item): item is { label: string; detail: string; href: string } => item !== null);
      return {
        forModel: { complete: items.length === 0, missing: items.map((item) => item.label) },
        block: { type: "missingData", title: "Data readiness", items },
      };
    },
  }),

  read({
    name: "get_available_categories",
    title: "Available categories",
    description: "Category names + ids, so writes can reference a valid category.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const cats = (await listCategories(ctx.userId)).slice(0, 100);
      return { forModel: { categories: cats.map((c) => ({ id: c.id, name: c.name })) } };
    },
  }),

  read({
    name: "get_available_accounts",
    title: "Available accounts",
    description: "Account names + ids + currency, so writes can reference a valid account.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const accounts = (await listAccounts(ctx.userId)).filter((a) => !a.isArchived).slice(0, 50);
      return {
        forModel: {
          accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currencyCode })),
        },
      };
    },
  }),

  read({
    name: "propose_rule",
    title: "Propose a rule (dry run)",
    description: `Build a deterministic rule from typed conditions and actions — the same vocabulary and name resolution as create_rule — and DRY-RUN it against the ledger. Does NOT save or activate anything. ${RULE_SEMANTICS} Scan: every non-deleted transaction in status pending, imported, reviewed or posted (rejected rows are never touched by rules); scannedCount is that total, matchedCount how many the conditions select. alreadyInTargetCount is how many of those matches the actions would leave unchanged (category already set, merchant already renamed, already reviewed or posted, every tag already present), so matchedCount − alreadyInTargetCount is what run_rule would report as applied right now. sample: up to 8 matched rows, newest first, each with date, description, signed amount in minor units, currency, current category and status, and wouldChange. resolved echoes the conditions and actions as stored (names resolved to ids, amounts converted to minor units). Always propose before creating.`,
    requiredScope: "rules:read",
    input: ruleDefinitionInput,
    async execute(ctx, args) {
      const { definition, when, then, conditionLabels, actionLabels } = await resolveRuleDefinition(ctx, args);
      const [preview, categories] = await Promise.all([
        rulePreview(ctx, definition),
        listCategories(ctx.userId),
      ]);
      const categoryName = new Map(categories.map((c) => [c.id, c.name]));
      const broad = preview.matchedCount > 50 || args.conditions.some((c) => c.field.includes("contains") && c.value.length < 3);
      const sample = preview.sample.map((s) => ({
        id: s.id,
        date: s.date,
        description: s.description,
        amountMinor: s.amountMinor,
        currency: s.currencyCode,
        category: s.categoryId ? (categoryName.get(s.categoryId) ?? null) : null,
        status: s.status,
        wouldChange: s.wouldChange,
      }));
      return {
        forModel: {
          name: definition.name,
          when,
          then,
          resolved: { matchAll: definition.matchAll, conditions: definition.conditions, actions: definition.actions },
          matchedCount: preview.matchedCount,
          alreadyInTargetCount: preview.alreadyInTargetCount,
          wouldChangeCount: preview.matchedCount - preview.alreadyInTargetCount,
          scannedCount: preview.scannedCount,
          sample,
          warning: broad ? "This looks broad — consider narrowing the conditions before activating." : undefined,
          note: "Not saved. Call create_rule to activate after the user confirms.",
        },
        block: {
          type: "ruleDraft",
          draft: {
            name: definition.name,
            matchAll: definition.matchAll,
            conditions: definition.conditions.map((c, i) => ({ field: c.field, value: c.value, label: conditionLabels[i]! })),
            actions: definition.actions.map((a, i) => ({ type: a.type, value: a.value ?? null, label: actionLabels[i]! })),
            matchedCount: preview.matchedCount,
            scannedCount: preview.scannedCount,
            sample: sample.map((s) => ({
              description: s.description,
              date: s.date,
              amountMinor: s.amountMinor,
              currency: s.currency,
            })),
            warning: broad ? "This looks broad — consider narrowing the conditions before activating." : undefined,
          },
        },
      };
    },
  }),

  /* ── finance domain (deterministic forecast/planning engine) ────────────── */

  read({
    name: "get_position",
    title: "Financial position",
    description:
      "Liquid account balances (cash/asset/wallet), the consolidated total, and which balances are stale (older than the freshness policy).",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const position = await getFinancePosition(ctx.userId);
      return {
        forModel: {
          asOf: position.asOf,
          currency: ctx.currency,
          balanceMinor: position.balanceMinor,
          accounts: position.accounts.map((account) => ({
            id: account.id,
            name: account.name,
            balanceMinor: account.balanceMinor,
            currency: account.currencyCode,
            observedAt: account.observedAt,
            source: account.source,
            ageDays: account.ageDays,
            isStale: account.isStale,
          })),
          staleAccountNames: position.staleAccountNames,
        },
      };
    },
  }),

  read({
    name: "get_budget_forecast",
    title: "Budgets in the forecast",
    description:
      "How budgets feed the cash forecast, per month (default this month and next): projected closing balance and lowest balance with its date, and estimatedVariableMinor (the budgets' remaining for the month, already inside those figures). Per budget and month: plannedMinor; spentMinor (expenses already in the ledger in its categories this month); committedMinor (what the forecast already carries in its categories later this month) with committedBySource taking it apart — one row per source with kind ('bill', 'recurring_rule', 'projected_event', 'card_parcel' = projected parcel of a past card purchase counted in its statement's month, 'other'), sourceId, label, occurrences summed, firstDate and amountMinor; the rows sum to committedMinor exactly. remainingMinor = max(0, planned − spent − committed) is what the forecast sets aside (the budget is the ceiling; LOW confidence). routeMix splits remainingMinor by how the categories were paid over the last 3 full months: per route cardId (null = cash), label ('Cash' or the card name), shareBasisPoints (of 10 000), amountMinor (the parts sum to remainingMinor exactly), settlementDates (cash: first and last day it is spread over; card: due date of each statement it is billed on) and beyondHorizonMinor (the part settling after horizonEnd, e.g. spending late in the last month billed on a statement due later — it exists but is not in these balances). beyondHorizonMinor per budget is the sum over routes. Budgets left out are listed in blockers with the reason.",
    requiredScope: "finance:read",
    input: z.object({ months: z.number().int().min(1).max(6).default(2) }),
    async execute(ctx, args) {
      const result = await getBudgetForecast(ctx.userId, args.months);
      return {
        forModel: {
          currency: ctx.currency,
          horizonEnd: result.horizonEnd,
          months: result.outlook,
          budgets: result.estimates.map((estimate) => ({
            budget: estimate.budgetName,
            month: estimate.month,
            plannedMinor: estimate.plannedMinor,
            spentMinor: estimate.spentMinor,
            committedMinor: estimate.committedMinor,
            committedBySource: estimate.committedBySource,
            remainingMinor: estimate.remainingMinor,
            beyondHorizonMinor: estimate.beyondHorizonMinor,
            routeMix: estimate.routeMix.map((route) => ({
              cardId: route.cardId,
              label: route.label,
              shareBasisPoints: route.shareBasisPoints,
              amountMinor: route.amountMinor,
              beyondHorizonMinor: route.beyondHorizonMinor,
              settlementDates: route.settlementDates,
            })),
          })),
          blockers: result.blockers.map((blocker) => ({ budget: blocker.budgetName, code: blocker.code })),
        },
      };
    },
  }),

  read({
    name: "get_projected_commitments",
    title: "Projected commitments",
    description:
      "Unpaid commitments from the deterministic forecast engine (bills, recurring rules, card statements) within the horizon (default 30 days), each labelled and confidence-rated. Distinct from get_upcoming_commitments, which lists tracked bills only.",
    requiredScope: "finance:read",
    input: z.object({ horizonDays: z.number().int().min(1).max(365).default(30) }),
    async execute(ctx, args) {
      const commitments = await getProjectedCommitments(ctx.userId, args.horizonDays);
      return {
        forModel: { currency: ctx.currency, commitments },
      };
    },
  }),

  read({
    name: "get_confidence_breakdown",
    title: "Forecast confidence breakdown",
    description:
      "How much of the projected cash volume rests on facts (actual/confirmed) versus assumptions (high/medium/low confidence), by amount and share of total.",
    requiredScope: "finance:read",
    input: z.object({ horizonDays: z.number().int().min(1).max(365).default(30) }),
    async execute(ctx, args) {
      const breakdown = await getConfidenceBreakdown(ctx.userId, args.horizonDays);
      return {
        forModel: {
          currency: ctx.currency,
          totalMinor: breakdown.totalMinor,
          byConfidence: breakdown.byConfidence,
          sharePercent: breakdown.sharePercent,
        },
      };
    },
  }),

  read({
    name: "simulate_purchase",
    title: "Simulate a purchase",
    description:
      "Runs one payment option through the deterministic planning engine against the forecast (horizon context.horizonDays, default 30; scenario 'budget' by default — includes what each budget still allows — or 'none'), and reports the engine's output verbatim. " +
      "Settlements: a non-card method settles in full on purchaseDate (default today); a card settles one instalment per statement, on the due dates of the card's recorded cycles from the purchase's cycle onward, else the nominal closing/due days. firstSettlementDate = the first of those dates; immediateImpactMinor = cash leaving on firstSettlementDate (the name is historical: it is only 'today' for a non-card payment made today; for a card it is the first instalment). monthlyImpactMinor = the option's cash outflow per month, chronological. " +
      "minimumBalanceBefore/AfterMinor = the forecast's lowest daily closing without/with the purchase; safeToSpendBefore/AfterMinor = max(0, that − hard reserve). " +
      "Verdict (rejections in order, reasons with raw minor units): NEGATIVE_BALANCE when the trough after falls below the floor of 0; HARD_RESERVE_VIOLATED when it falls below a hard reserve > 0 (never reported for a zero reserve, which is the floor itself); CREDIT_LIMIT_EXCEEDED when the card's peak usage exceeds its limit; DEADLINE_EXCEEDED when the last settlement is after context.maxLastPaymentDate. When the forecast is already below the floor (or a hard reserve > 0) before buying, baselineBreach reports it and the bar becomes 'does not lower the trough': the purchase passes if minimumBalanceAfter ≥ minimumBalanceBefore, else it is rejected with the level it is under. " +
      "cardUsage (card options): committedMinor today, baselinePeakMinor/Date without, peakMinor/Date with the purchase, exceededMinor; cardHeadroomAtPeakMinor = creditLimitMinor − cardUsage.peakMinor. cardUtilizationAfterMinor is deprecated: the same number as cardUsage.peakMinor, kept for compatibility. See get_methodology.purchaseSimulation.",
    requiredScope: "finance:read",
    input: z.object({ option: purchaseOptionInput, context: simulationContextInput }),
    async execute(ctx, args) {
      const result = await simulateUserPurchase(ctx.userId, args.option, {
        horizonDays: args.context.horizonDays,
        maxLastPaymentDate: args.context.maxLastPaymentDate,
        scenario: args.context.scenario,
      });
      return {
        forModel: {
          currency: ctx.currency,
          optionId: result.optionId,
          label: result.label,
          totalCostMinor: result.totalCostMinor,
          firstSettlementDate: result.firstSettlementDate ?? null,
          immediateImpactMinor: result.immediateImpactMinor,
          monthlyImpactMinor: result.monthlyImpactMinor,
          safeToSpendBeforeMinor: result.safeToSpendBeforeMinor,
          safeToSpendAfterMinor: result.safeToSpendAfterMinor,
          minimumBalanceBeforeMinor: result.minimumBalanceBeforeMinor,
          minimumBalanceAfterMinor: result.minimumBalanceAfterMinor,
          minimumBalanceDateAfter: result.minimumBalanceDateAfter,
          baselineBreach: result.baselineBreach ?? null,
          hardReserveViolated: result.hardReserveViolated,
          softReserveImpacts: result.softReserveImpacts,
          creditLimitExceededMinor: result.creditLimitExceededMinor,
          cardUtilizationAfterMinor: result.cardUtilizationAfterMinor,
          cardUsage: result.cardUsage,
          cardHeadroomAtPeakMinor: result.cardHeadroomAtPeakMinor,
          lastPaymentDate: result.lastPaymentDate,
          installments: result.installments,
          feasible: result.feasible,
          rejections: result.rejections,
          reasons: result.reasons,
        },
      };
    },
  }),

  read({
    name: "compare_payment_options",
    title: "Compare payment options",
    description:
      "Compares payment alternatives for the same purchase against one shared forecast (context as in simulate_purchase: horizonDays default 30, scenario 'budget' or 'none', maxLastPaymentDate). Each option carries the same verdict simulate_purchase gives (feasible, rejections, reasons, minimumBalance, cardUsage, cardHeadroomAtPeakMinor = limit − peak usage, peakMonthlyOutflowMinor = its largest single-month cash outflow). " +
      "ranking lists every option best first, whatever the status: feasible ones first; among infeasible ones fewer rejections first; then lowest totalCostMinor → highest minimumBalanceMinor → lowest peakMonthlyOutflowMinor → earliest lastPaymentDate → lowest soft-reserve shortfall → most cardHeadroomAtPeakMinor (an option on no card counts as the most) → id. Each entry says decidedBy (the first criterion on which it lost to the option ranked just above, comparedWithOptionId) and an explanation with both raw values. " +
      "status OK → recommendedOptionId is ranking[0]. NO_FEASIBLE_OPTION → no recommendation; leastBadOptionId is ranking[0], the least bad, which must be presented as such, never as a recommendation; blockers say what each option breaks. INSUFFICIENT_DATA → no options. baselineBreach is set when the forecast is already below the floor before buying (the bar is then 'does not lower the trough').",
    requiredScope: "finance:read",
    input: z.object({ options: z.array(purchaseOptionInput).min(1).max(10), context: simulationContextInput }),
    async execute(ctx, args) {
      const result = await compareUserPaymentOptions(ctx.userId, args.options, {
        horizonDays: args.context.horizonDays,
        maxLastPaymentDate: args.context.maxLastPaymentDate,
        scenario: args.context.scenario,
      });
      return {
        forModel: {
          currency: ctx.currency,
          status: result.status,
          recommendedOptionId: result.recommendedOptionId,
          leastBadOptionId: result.leastBadOptionId,
          baselineBreach: result.baselineBreach ?? null,
          blockers: result.blockers,
          ranking: result.ranking,
          options: result.options.map((option) => ({
            id: option.id,
            label: option.label,
            totalCostMinor: option.totalCostMinor,
            minimumBalanceMinor: option.minimumBalanceMinor,
            minimumBalanceDate: option.minimumBalanceDate,
            hardReserveViolated: option.hardReserveViolated,
            safeToSpendAfterMinor: option.safeToSpendAfterMinor,
            feasible: option.feasible,
            rejections: option.rejections,
            reasons: option.reasons,
            softReserveImpacts: option.softReserveImpacts,
            creditLimitExceededMinor: option.creditLimitExceededMinor,
            cardUsage: option.cardUsage,
            cardHeadroomAtPeakMinor: option.cardHeadroomAtPeakMinor,
            lastPaymentDate: option.lastPaymentDate,
            installments: option.installments,
            peakMonthlyOutflowMinor: option.peakMonthlyOutflowMinor,
          })),
        },
      };
    },
  }),

  read({
    name: "recommend_purchase_plan",
    title: "Recommend a purchase plan",
    description:
      "Given a shopping list (items with an amount and, optionally, a needed-by date and an installment cap), the engine generates every way to pay each item — in full (one cash settlement today), plus each active card at 1, 2, 3, 4, 5, 6, 10 and 12 instalments (those above the item's maxInstallments are not generated), all bought today — and decides the cash-preserving way to pay the whole basket over a 365-day forecast (scenario 'budget' by default, or 'none'). " +
      "Items are decided one by one, earliest deadline first, then most expensive, then id; each candidate is checked against what earlier choices already occupy (cash and card limits). A candidate is workable when it breaks nothing: balance (NEGATIVE_BALANCE below the 0 floor; HARD_RESERVE_VIOLATED below a hard reserve > 0; when the forecast is already below the floor before buying — baselineBreach — the bar is 'does not lower that trough'), card limit by peak usage, deadline, instalment cap. Among workable ones it prefers: highest trough → lowest peak monthly outflow → lowest total cost → fewest instalments → most card limit left free at the card's peak (cardHeadroomAtPeakMinor; cash counts as the most) → id. Each choice reports decidedBy (the criterion that beat runnerUpOptionId, the next-best workable way) and workableCount. " +
      "When nothing works for an item, the least-bad candidate (fewest walls hit, then the same preference) is still returned with fits=false, its rejections, and a blockedItems entry counting how many candidates failed each way (cappedCount, lateCount, overCardCount, belowFloorCount — each candidate counted once, under the first of those it hits). simulation is the whole chosen basket judged by the same rules as get_purchase_plan_impact. Never invents a recommendation: NO_FEASIBLE_PLAN and INSUFFICIENT_DATA are propagated as-is, not softened into a suggestion.",
    requiredScope: "finance:read",
    input: z.object({
      items: z.array(planRecommendationItemInput).min(1).max(20),
      targetDate: isoDateSchema.optional().describe("plan-level deadline; an item without its own neededBy inherits it"),
      scenario: z
        .enum(["none", "budget"])
        .optional()
        .describe("'budget' (default): the baseline includes what each budget still allows; 'none': commitments only"),
    }),
    async execute(ctx, args) {
      const items = args.items.map((item) => ({
        label: item.label,
        amountMinor: majorToMinor(item.amount, ctx.currency),
        neededBy: item.neededBy,
        maxInstallments: item.maxInstallments,
      }));
      const result = await recommendUserPurchasePlan(ctx.userId, items, {
        targetDate: args.targetDate,
        scenario: args.scenario,
      });
      return {
        forModel: {
          currency: ctx.currency,
          status: result.status,
          blockers: result.blockers,
          baselineBreach: result.baselineBreach,
          shortfallMinor: result.shortfallMinor,
          shortfallDate: result.shortfallDate,
          choices: result.choices.map((choice) => ({
            itemId: choice.itemId,
            label: choice.label,
            optionId: choice.optionId,
            optionLabel: choice.optionLabel,
            totalCostMinor: choice.totalCostMinor,
            installments: choice.installments,
            installmentAmountMinor: choice.installmentAmountMinor,
            firstPaymentDate: choice.firstPaymentDate,
            lastPaymentDate: choice.lastPaymentDate,
            cardId: choice.cardId,
            cardLabel: choice.cardLabel,
            cardHeadroomAtPeakMinor: choice.cardHeadroomAtPeakMinor,
            minimumBalanceMinor: choice.minimumBalanceMinor,
            minimumBalanceDate: choice.minimumBalanceDate,
            decidedBy: choice.decidedBy,
            runnerUpOptionId: choice.runnerUpOptionId,
            workableCount: choice.workableCount,
            fits: choice.fits,
            rejections: choice.rejections,
            reasons: choice.reasons,
          })),
          blockedItems: result.blockedItems,
          simulation: result.simulation
            ? {
                totalCostMinor: result.simulation.totalCostMinor,
                safeToSpendBeforeMinor: result.simulation.safeToSpendBeforeMinor,
                safeToSpendAfterMinor: result.simulation.safeToSpendAfterMinor,
                minimumBalanceBeforeMinor: result.simulation.minimumBalanceBeforeMinor,
                minimumBalanceBeforeDate: result.simulation.minimumBalanceBeforeDate,
                minimumBalanceAfterMinor: result.simulation.minimumBalanceAfterMinor,
                minimumBalanceAfterDate: result.simulation.minimumBalanceAfterDate,
                hardReserveViolated: result.simulation.hardReserveViolated,
                feasible: result.simulation.feasible,
                rejections: result.simulation.rejections,
                reasons: result.simulation.reasons,
                softReserveImpacts: result.simulation.softReserveImpacts,
                cards: result.simulation.cards,
                monthlyOutlook: result.simulation.monthlyOutlook,
              }
            : undefined,
        },
      };
    },
  }),
];

/* ── WRITE TOOLS ────────────────────────────────────────────────────────── */

const writeTools: WriteTool[] = [
  write({
    name: "categorise_transaction",
    title: "Categorise transaction",
    description: "Set the category of one transaction (by id) using a category name.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      id: z.string().uuid(),
      category: z.string(),
    }),
    async prepare(ctx, args) {
      const tx = await getTransaction(ctx.userId, args.id);
      if (!tx) throw new Error("Transaction not found.");
      const category = await resolveCategory(ctx.userId, args.category);
      if (!category) throw new Error(`No category matching "${args.category}".`);
      return {
        payload: { id: args.id, categoryId: category.id },
        title: "Change category?",
        summary: tx.description,
        fields: [
          { label: "Transaction", value: tx.description },
          { label: "From", value: tx.category?.name ?? "Uncategorised" },
          { label: "To", value: category.name },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; categoryId: string };
      await updateTransactionCore(ctx.userId, p.id, { categoryId: p.categoryId });
      return { status: "completed" as ExecStatus, title: "Category updated" };
    },
  }),

  write({
    name: "mark_transaction_reviewed",
    title: "Mark reviewed",
    description:
      "Approve transactions by id, as the Inbox's Approve button does: every id in status pending, imported or reviewed becomes `posted` (there is no separate 'reviewed' result; `reviewed` is what a rule's mark_reviewed action sets, and approving promotes it to posted too) and its suspected-duplicate flag is cleared. Posted, rejected, deleted and other users' ids are skipped. A pending row starts counting in account balances, reports and the forecast now (imported and reviewed rows already counted); the affected account balances, both legs of a transfer, are recomputed. Applies immediately when called; returns how many were approved.",
    risk: "write",
    requiredScope: "reviews:write",
    input: z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }),
    async prepare(_ctx, args) {
      return {
        payload: { ids: args.ids },
        title: "Mark reviewed?",
        summary: `${args.ids.length} transaction(s) will be approved into your ledger.`,
        fields: [{ label: "Count", value: String(args.ids.length) }],
        affectedCount: args.ids.length,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { ids: string[] };
      const r = await approveTransactionsCore(ctx.userId, p);
      return { status: "completed" as ExecStatus, title: `Approved ${r.approved}` };
    },
  }),

  write({
    name: "bulk_categorise_matching_transactions",
    title: "Bulk categorise",
    description:
      "Categorise every transaction whose description matches a text query. Always shows the exact list before applying.",
    risk: "sensitive",
    requiredScope: "transactions:write",
    input: z.object({
      matchText: z.string().min(1).max(100),
      category: z.string(),
    }),
    async prepare(ctx, args) {
      const category = await resolveCategory(ctx.userId, args.category);
      if (!category) throw new Error(`No category matching "${args.category}".`);
      const { items } = await listTransactions(ctx.userId, {
        q: args.matchText,
        page: 1,
        pageSize: 200,
      } as Parameters<typeof listTransactions>[1]);
      if (items.length === 0) throw new Error(`No transactions match "${args.matchText}".`);
      const ids = items.map((t) => t.id);
      return {
        payload: { ids, categoryId: category.id },
        title: "Recategorise these?",
        summary: `${items.length} transaction(s) matching "${args.matchText}" → ${category.name}.`,
        fields: items.slice(0, 6).map((t) => ({
          label: t.date,
          value: `${t.description} · ${formatMoney(t.amountMinor, t.currencyCode)}`,
        })),
        affectedCount: items.length,
        warning: items.length > 20 ? "This affects a large number of transactions." : undefined,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { ids: string[]; categoryId: string };
      const r = await bulkCategorizeCore(ctx.userId, p);
      return { status: "completed" as ExecStatus, title: `Recategorised ${r.updated}` };
    },
  }),

  write({
    name: "set_rule_active",
    title: "Enable/disable rule",
    description: "Turn an existing rule on or off by id.",
    risk: "write",
    requiredScope: "rules:write",
    input: z.object({ id: z.string().uuid(), active: z.boolean() }),
    async prepare(ctx, args) {
      const rules = await listRulesCore(ctx.userId);
      const rule = rules.find((r) => r.id === args.id);
      if (!rule) throw new Error("Rule not found.");
      return {
        payload: { id: args.id, active: args.active },
        title: args.active ? "Enable rule?" : "Disable rule?",
        summary: rule.name,
        fields: [{ label: "Rule", value: rule.name }, { label: "State", value: args.active ? "Enabled" : "Disabled" }],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; active: boolean };
      const r = await setRuleActiveCore(ctx.userId, p.id, p.active);
      return { status: "completed" as ExecStatus, title: r.isActive ? "Rule enabled" : "Rule disabled", detail: r.name };
    },
  }),

  write({
    name: "run_rule",
    title: "Run rule now",
    description:
      "Run a stored rule now, as the Automations page's Run button does. It applies immediately when called (there is no separate confirmation over MCP; use propose_rule first to see the matches). Scope: every non-deleted transaction in status pending, imported, reviewed or posted, whatever its date (rejected rows are never touched), filtered by the rule's conditions. Each match gets the rule's actions: set_category sets the transaction's category, add_tag adds the tag, rename_merchant sets the merchant, mark_reviewed moves pending/imported rows to `reviewed`. The result counts matched (rows the conditions selected) and applied (rows actually changed: a match already in the target state — same category, merchant already renamed, tag already present, already reviewed or posted — is not counted). The run is recorded in get_rule_runs with trigger manual. Changes are ordinary ledger edits and are not undone by deleting the rule.",
    risk: "sensitive",
    requiredScope: "rules:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const rules = await listRulesCore(ctx.userId);
      const rule = rules.find((r) => r.id === args.id);
      if (!rule) throw new Error("Rule not found.");
      return {
        payload: { id: args.id },
        title: "Run this rule now?",
        summary: `${rule.name} will be applied to your recent transactions.`,
        fields: [{ label: "Rule", value: rule.name }],
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      const r = await runRuleCore(ctx.userId, p.id);
      return {
        status: "completed" as ExecStatus,
        title: `Applied to ${r.applied}`,
        detail: `${r.matched} matched, ${r.applied} changed, ${r.matched - r.applied} already in the target state`,
      };
    },
  }),

  write({
    name: "create_purchase_plan",
    title: "Create purchase plan",
    description:
      "Create a purchase plan (a planning list such as 'Baby layette' that groups items to buy by a target date). budget is optional and in major units (e.g. 1500.50, not cents). currencyCode defaults to the user's currency; items added later are priced in it. Returns the new plan id; add items with create_purchase_item.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).optional(),
      targetDate: isoDateSchema.optional().describe("yyyy-MM-dd"),
      budget: z.number().nonnegative().optional().describe("major units"),
      currencyCode: currencyCodeInput.optional(),
      status: planStatusInput.default("active"),
    }),
    async prepare(ctx, args) {
      const currencyCode = (args.currencyCode ?? ctx.currency).toUpperCase();
      const payload: CreatePurchasePlanInput = {
        name: args.name,
        description: args.description,
        targetDate: args.targetDate ?? null,
        budget: args.budget ?? null,
        currencyCode,
        status: args.status,
      };
      return {
        payload,
        title: "Create purchase plan?",
        summary: args.name,
        fields: [
          { label: "Name", value: args.name },
          { label: "Currency", value: currencyCode },
          ...(args.budget != null ? [{ label: "Budget", value: formatMajor(args.budget, currencyCode) }] : []),
          ...(args.targetDate ? [{ label: "By", value: args.targetDate }] : []),
          ...(args.status !== "active" ? [{ label: "Status", value: args.status }] : []),
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const plan = await createPurchasePlanCore(ctx.userId, payload as CreatePurchasePlanInput);
      return {
        status: "completed" as ExecStatus,
        title: "Purchase plan created",
        detail: `${plan.name} (id ${plan.id})`,
      };
    },
  }),

  write({
    name: "update_purchase_plan",
    title: "Update purchase plan",
    description:
      "Change fields of an existing purchase plan by id (get ids from get_purchase_plans). Only the fields you pass change. budget is in major units; pass null to clear budget or targetDate. Changing currencyCode does not convert existing item prices.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      targetDate: isoDateSchema.nullable().optional().describe("yyyy-MM-dd, or null to clear"),
      budget: z.number().nonnegative().nullable().optional().describe("major units, or null to clear"),
      currencyCode: currencyCodeInput.optional(),
      status: planStatusInput.optional(),
    }),
    async prepare(ctx, args) {
      const plan = await getPurchasePlan(ctx.userId, args.id);
      if (!plan) throw new Error("Purchase plan not found.");
      const { id, ...rest } = args;
      const changes: UpdatePurchasePlanInput = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      );
      if (changes.currencyCode) changes.currencyCode = changes.currencyCode.toUpperCase();
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      const currency = changes.currencyCode ?? plan.currencyCode;
      const fields = [
        changes.name !== undefined && { label: "Name", value: changes.name },
        changes.description !== undefined && { label: "Description", value: changes.description },
        changes.targetDate !== undefined && { label: "By", value: changes.targetDate ?? "No date" },
        changes.budget !== undefined && {
          label: "Budget",
          value: changes.budget == null ? "No budget" : formatMajor(changes.budget, currency),
        },
        changes.currencyCode !== undefined && { label: "Currency", value: changes.currencyCode },
        changes.status !== undefined && { label: "Status", value: changes.status },
      ].filter((field): field is { label: string; value: string } => Boolean(field));
      return {
        payload: { id, changes },
        title: "Update purchase plan?",
        summary: plan.name,
        fields,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdatePurchasePlanInput };
      await updatePurchasePlanCore(ctx.userId, p.id, p.changes);
      return { status: "completed" as ExecStatus, title: "Purchase plan updated", detail: `id ${p.id}` };
    },
  }),

  write({
    name: "delete_purchase_plan",
    title: "Delete purchase plan",
    description:
      "Permanently delete a purchase plan by id (get ids from get_purchase_plans), together with all of its items. Cannot be undone; to keep the plan but stop using it, use update_purchase_plan with status 'archived' instead.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const plan = await getPurchasePlan(ctx.userId, args.id);
      if (!plan) throw new Error("Purchase plan not found.");
      return {
        payload: { id: args.id },
        title: "Delete purchase plan?",
        summary: `${plan.name} and its ${plan.items.length} item(s) will be deleted.`,
        fields: [
          { label: "Plan", value: plan.name },
          { label: "Items", value: String(plan.items.length) },
        ],
        affectedCount: plan.items.length + 1,
        warning: "This permanently deletes the plan and every item in it.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await deletePurchasePlanCore(ctx.userId, p.id);
      return { status: "completed" as ExecStatus, title: "Purchase plan deleted", detail: `id ${p.id}` };
    },
  }),

  write({
    name: "create_purchase_item",
    title: "Add purchase item",
    description:
      "Add an item to a purchase plan (planId from get_purchase_plans). amount is the estimated price in major units of the plan's currency (e.g. 2500 or 2499.90, not cents). Optionally set purchaseDate (yyyy-MM-dd), the paying account by name (as in get_accounts), and installments (only meaningful on a credit-card account). An item with both an account and a purchaseDate is drawn on the forecast. Returns the new item id.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      planId: z.string().uuid(),
      name: z.string().min(1).max(120),
      amount: z.number().nonnegative().describe("major units"),
      purchaseDate: isoDateSchema.optional().describe("yyyy-MM-dd"),
      account: z.string().min(1).optional().describe("account name"),
      installments: z.number().int().min(1).default(1),
    }),
    async prepare(ctx, args) {
      const plan = await getPurchasePlan(ctx.userId, args.planId);
      if (!plan) throw new Error("Purchase plan not found.");
      const account = args.account ? await resolveNamedAccount(ctx.userId, args.account) : null;
      const payload: CreatePurchaseItemInput = {
        purchasePlanId: plan.id,
        name: args.name,
        amount: args.amount,
        purchaseDate: args.purchaseDate ?? null,
        accountId: account?.id ?? null,
        installments: args.installments,
      };
      return {
        payload,
        title: "Add purchase item?",
        summary: `${args.name} → ${plan.name}`,
        fields: [
          { label: "Plan", value: plan.name },
          { label: "Item", value: args.name },
          { label: "Price", value: formatMajor(args.amount, plan.currencyCode) },
          { label: "Account", value: account?.name ?? "Not set" },
          { label: "Installments", value: String(args.installments) },
          { label: "Date", value: args.purchaseDate ?? "Not set" },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const item = await createPurchaseItemCore(ctx.userId, payload as CreatePurchaseItemInput);
      return {
        status: "completed" as ExecStatus,
        title: "Purchase item added",
        detail: `${item.name} (id ${item.id})`,
      };
    },
  }),

  write({
    name: "update_purchase_item",
    title: "Update purchase item",
    description:
      "Change fields of an existing purchase item by id (item ids come from get_purchase_plans or get_purchase_plan). Only the fields you pass change. amount is in major units of the plan's currency. account is an account name; pass null to clear account or purchaseDate.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      amount: z.number().nonnegative().optional().describe("major units"),
      purchaseDate: isoDateSchema.nullable().optional().describe("yyyy-MM-dd, or null to clear"),
      account: z.string().min(1).nullable().optional().describe("account name, or null to clear"),
      installments: z.number().int().min(1).optional(),
    }),
    async prepare(ctx, args) {
      const item = await getPurchaseItem(ctx.userId, args.id);
      if (!item) throw new Error("Purchase item not found.");
      const account =
        args.account == null ? args.account : await resolveNamedAccount(ctx.userId, args.account);
      const changes: UpdatePurchaseItemInput = {};
      if (args.name !== undefined) changes.name = args.name;
      if (args.amount !== undefined) changes.amount = args.amount;
      if (args.purchaseDate !== undefined) changes.purchaseDate = args.purchaseDate;
      if (account !== undefined) changes.accountId = account?.id ?? null;
      if (args.installments !== undefined) changes.installments = args.installments;
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      const currency = item.purchasePlan.currencyCode;
      const fields = [
        changes.name !== undefined && { label: "Name", value: changes.name },
        changes.amount !== undefined && { label: "Price", value: formatMajor(changes.amount, currency) },
        changes.purchaseDate !== undefined && { label: "Date", value: changes.purchaseDate ?? "Not set" },
        account !== undefined && { label: "Account", value: account?.name ?? "Not set" },
        changes.installments !== undefined && { label: "Installments", value: String(changes.installments) },
      ].filter((field): field is { label: string; value: string } => Boolean(field));
      return {
        payload: { id: args.id, changes },
        title: "Update purchase item?",
        summary: `${item.name} (${item.purchasePlan.name})`,
        fields,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdatePurchaseItemInput };
      await updatePurchaseItemCore(ctx.userId, p.id, p.changes);
      return { status: "completed" as ExecStatus, title: "Purchase item updated", detail: `id ${p.id}` };
    },
  }),

  write({
    name: "set_purchase_item_active",
    title: "Set purchase item aside / back",
    description:
      "Set a purchase item aside (isActive=false) or bring it back (isActive=true) by id (item ids come from get_purchase_plans or get_purchase_plan). An inactive item stays listed but counts toward neither the plan's totals nor its projection; use this for 'what if I skip this' instead of deleting.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid(), isActive: z.boolean() }),
    async prepare(ctx, args) {
      const item = await getPurchaseItem(ctx.userId, args.id);
      if (!item) throw new Error("Purchase item not found.");
      return {
        payload: { id: args.id, isActive: args.isActive },
        title: args.isActive ? "Bring item back?" : "Set item aside?",
        summary: `${item.name} (${item.purchasePlan.name})`,
        fields: [
          { label: "Item", value: item.name },
          { label: "Price", value: formatMoney(item.estimatedPriceMinor, item.purchasePlan.currencyCode) },
          { label: "State", value: args.isActive ? "Counted in the plan" : "Set aside" },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; isActive: boolean };
      await setPurchaseItemActiveCore(ctx.userId, p.id, { isActive: p.isActive });
      return {
        status: "completed" as ExecStatus,
        title: p.isActive ? "Purchase item brought back" : "Purchase item set aside",
        detail: `id ${p.id}`,
      };
    },
  }),

  write({
    name: "delete_purchase_item",
    title: "Delete purchase item",
    description:
      "Permanently delete one purchase item by id (item ids come from get_purchase_plans or get_purchase_plan). Cannot be undone; to only exclude it from totals and projections, use set_purchase_item_active with isActive=false instead.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const item = await getPurchaseItem(ctx.userId, args.id);
      if (!item) throw new Error("Purchase item not found.");
      return {
        payload: { id: args.id },
        title: "Delete purchase item?",
        summary: `${item.name} will be removed from ${item.purchasePlan.name}.`,
        fields: [
          { label: "Plan", value: item.purchasePlan.name },
          { label: "Item", value: item.name },
          { label: "Price", value: formatMoney(item.estimatedPriceMinor, item.purchasePlan.currencyCode) },
        ],
        warning: "This permanently deletes the item.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await deletePurchaseItemCore(ctx.userId, p.id);
      return { status: "completed" as ExecStatus, title: "Purchase item deleted", detail: `id ${p.id}` };
    },
  }),
];

/* ── the registry ───────────────────────────────────────────────────────── */

// Each domain keeps its tools in `./tools/<domain>.ts`; this list is the only
// place they are joined, so a tool defined there and not added here is dead.
export const TOOLS: Tool[] = [
  ...readTools,
  ...financeReadsTools,
  ...ledgerReadsTools,
  ...financeWritesReadTools,
  ...writeTools,
  ...financeWritesTools,
  ...ledgerWritesTools,
];
export const MCP_TOOLS: Tool[] = TOOLS;
export const TOOL_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

export function toolsForScopes(scopes: Scope[]): Tool[] {
  return TOOLS.filter((t) => scopes.includes(t.requiredScope));
}
