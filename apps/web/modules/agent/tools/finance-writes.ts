import "server-only";
import { z } from "zod";
import { advanceOnePeriod, formatMoney, minorToMajor, todayIso } from "@kosh/domain";
import { listAccounts } from "@/modules/accounts/queries";
import { getBill } from "@/modules/bills/queries";
import {
  createBillCore,
  deleteBillCore,
  markBillPaidCore,
  updateBillCore,
} from "@/modules/bills/mutations";
import type { CreateBillInput, MarkBillPaidInput, UpdateBillInput } from "@/modules/bills/validators";
import { getBudget, listArchivedBudgets } from "@/modules/budgets/queries";
import {
  archiveBudgetCore,
  createBudgetCore,
  restoreBudgetCore,
  updateBudgetCore,
} from "@/modules/budgets/mutations";
import type { CreateBudgetInput, UpdateBudgetInput } from "@/modules/budgets/validators";
import {
  getCardStatement,
  listArchivedCreditCards,
  listCardPurchases,
  listCreditCards,
  listFinancialReserves,
} from "@/modules/finance/queries";
import {
  archiveCreditCardCore,
  createCreditCardCore,
  createFinancialReserveCore,
  deleteCardPurchaseCore,
  deleteFinancialReserveCore,
  reconcileBillingCycleCore,
  registerCardPurchaseCore,
  restoreCreditCardCore,
  updateCreditCardCore,
  updateFinancialReserveCore,
  upsertBalanceSnapshotCore,
} from "@/modules/finance/mutations";
import type {
  CreateCreditCardInput,
  CreateFinancialReserveInput,
  ReconcileBillingCycleInput,
  RegisterCardPurchaseInput,
  UpdateCreditCardInput,
  UpdateFinancialReserveInput,
  UpsertBalanceSnapshotInput,
} from "@/modules/finance/validators";
import { listGoals } from "@/modules/goals/queries";
import {
  contributeToGoalCore,
  createGoalCore,
  deleteGoalCore,
  updateGoalCore,
} from "@/modules/goals/mutations";
import type { CreateGoalInput, UpdateGoalInput } from "@/modules/goals/validators";
import { listRecurring } from "@/modules/recurring/queries";
import {
  createRecurringCore,
  deleteRecurringCore,
  setRecurringActiveCore,
  updateRecurringCore,
} from "@/modules/recurring/mutations";
import type { CreateRecurringInput, UpdateRecurringInput } from "@/modules/recurring/validators";
import { getTransaction, listUnlinkedExpenseCandidates } from "@/modules/transactions/queries";
import type { ConfirmField, ExecStatus, ReadTool, ResponseBlock, WriteTool } from "../types";
import {
  currencyCodeInput,
  formatMajor,
  isoDateSchema,
  read,
  resolveCategory,
  resolveNamedAccount,
  write,
} from "./shared";

/* ── local helpers ──────────────────────────────────────────────────────── */

/** Account types whose balance is spendable cash — the same set the cards
 * screen offers as "Paid from" and the position treats as liquid. */
const LIQUID_TYPES = ["asset", "cash", "wallet"];

function completed(title: string, detail?: string) {
  return {
    status: "completed" as ExecStatus,
    title,
    detail,
    block: { type: "result", status: "completed", title, detail } as ResponseBlock,
  };
}

function compact(fields: Array<ConfirmField | false | null | undefined>): ConfirmField[] {
  return fields.filter((field): field is ConfirmField => Boolean(field));
}

/** Category by name; unlike `resolveCategory` a miss throws instead of
 * silently leaving the record uncategorised. */
async function resolveNamedCategory(userId: string, name: string) {
  const category = await resolveCategory(userId, name);
  if (!category) throw new Error(`No category matching "${name}".`);
  return category;
}

/** A non-archived account by name, restricted to the given types. */
async function resolveAccountOfType(userId: string, name: string, types: string[], what: string) {
  const accounts = (await listAccounts(userId)).filter((a) => !a.isArchived && types.includes(a.type));
  const h = name.toLowerCase();
  const account =
    accounts.find((a) => a.name.toLowerCase() === h) ??
    accounts.find((a) => a.name.toLowerCase().includes(h));
  if (!account) {
    throw new Error(
      `No ${what} matching "${name}". Eligible accounts: ${accounts.map((a) => a.name).join(", ") || "none"}.`,
    );
  }
  return account;
}

async function allCards(userId: string) {
  const [active, archived] = await Promise.all([listCreditCards(userId), listArchivedCreditCards(userId)]);
  return { active, archived };
}

async function findCard(userId: string, cardId: string) {
  const { active, archived } = await allCards(userId);
  const activeCard = active.find((card) => card.id === cardId);
  if (activeCard) return { card: activeCard, archived: false };
  const archivedCard = archived.find((card) => card.id === cardId);
  if (archivedCard) return { card: archivedCard, archived: true };
  throw new Error("Credit card not found.");
}

/** Name of the active card that settles an account, if the account is a card's. */
async function activeCardOnAccount(userId: string, accountId: string | null | undefined) {
  if (!accountId) return null;
  const cards = await listCreditCards(userId);
  return cards.find((card) => card.accountId === accountId) ?? null;
}

async function findBill(userId: string, id: string) {
  const bill = await getBill(userId, id);
  if (!bill) throw new Error("Bill not found.");
  return bill;
}

async function findRecurring(userId: string, id: string) {
  const item = (await listRecurring(userId)).find((row) => row.id === id);
  if (!item) throw new Error("Recurring item not found.");
  return item;
}

async function findBudget(userId: string, id: string) {
  const budget = await getBudget(userId, id);
  if (!budget) throw new Error("Budget not found.");
  return budget;
}

async function findGoal(userId: string, id: string) {
  const goal = (await listGoals(userId)).find((row) => row.id === id);
  if (!goal) throw new Error("Goal not found.");
  return goal;
}

async function findReserve(userId: string, id: string) {
  const reserve = (await listFinancialReserves(userId)).find((row) => row.id === id);
  if (!reserve) throw new Error("Reserve not found.");
  return reserve;
}

function currencyNotice(currency: string, defaultCurrency: string, what: string) {
  return currency === defaultCurrency
    ? undefined
    : `This ${what} is in ${currency}, not your default ${defaultCurrency}. The forecast, safe-to-spend and budget estimate only read ${defaultCurrency} records, so it will be stored and listed but not projected.`;
}

const recurrenceInput = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
const amountStrategyInput = z.enum(["fixed", "variable"]);
const recurringTypeInput = z.enum(["income", "expense", "transfer"]);
const reserveKindInput = z.enum(["hard", "soft"]);
const dayOfMonth = z.number().int().min(1).max(31);

/* ── cards ──────────────────────────────────────────────────────────────── */

const cardTools: WriteTool[] = [
  write({
    name: "create_credit_card",
    title: "Add credit card",
    description:
      "Turn an existing ledger account of type 'credit_card' into a tracked credit card (the Cards screen's 'Add card'). " +
      "account: name of the credit-card account (must not already be linked to a card; if it is linked to an archived card, use restore_credit_card). " +
      "name, issuer and creditLimit default to what the account already records (its name, institution and limit), exactly as the screen pre-fills them; creditLimit is in major units and is required if the account has no limit. " +
      "The card's currency is always the account's currency. closingDay/dueDay (1-31) are the statement rules: a purchase made on or before the closing day is billed on that month's statement, due on dueDay. " +
      "paidFrom: optional name of the bank/cash/wallet account that settles the statement. " +
      "Forecast effect: from now on the card's statements are projected as one cash outflow per billing cycle on its due date (PRD R4), bills whose account is this card account stop being cash events on their due date and are folded into the statement instead, and available limit = credit limit − amount owed on the card account.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      account: z.string().min(1).describe("name of the credit_card ledger account"),
      name: z.string().min(1).max(120).optional(),
      issuer: z.string().max(120).optional(),
      creditLimit: z.number().nonnegative().optional().describe("major units"),
      closingDay: dayOfMonth,
      dueDay: dayOfMonth,
      paidFrom: z.string().min(1).optional().describe("name of the settling bank/cash/wallet account"),
    }),
    async prepare(ctx, args) {
      const account = await resolveAccountOfType(ctx.userId, args.account, ["credit_card"], "credit-card account");
      const { active, archived } = await allCards(ctx.userId);
      const linked = [...active, ...archived].find((card) => card.accountId === account.id);
      if (linked) {
        throw new Error(
          linked.active
            ? `${account.name} is already tracked as the card "${linked.name}".`
            : `${account.name} belongs to the archived card "${linked.name}" (id ${linked.id}); restore it with restore_credit_card instead.`,
        );
      }
      const name = args.name ?? account.name;
      if ([...active, ...archived].some((card) => card.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A card named "${name}" already exists; pass a different name.`);
      }
      const creditLimit =
        args.creditLimit ??
        (account.limitMinor != null ? Math.abs(minorToMajor(account.limitMinor, account.currencyCode)) : undefined);
      if (creditLimit === undefined) {
        throw new Error(`${account.name} records no credit limit; pass creditLimit.`);
      }
      const paidFrom = args.paidFrom
        ? await resolveAccountOfType(ctx.userId, args.paidFrom, LIQUID_TYPES, "bank, cash or wallet account")
        : null;
      const payload: CreateCreditCardInput = {
        accountId: account.id,
        name,
        issuer: args.issuer ?? account.institution ?? undefined,
        currencyCode: account.currencyCode,
        creditLimit,
        defaultClosingDay: args.closingDay,
        defaultDueDay: args.dueDay,
        paymentAccountId: paidFrom?.id ?? null,
        active: true,
      };
      return {
        payload,
        title: "Add credit card?",
        summary: name,
        fields: compact([
          { label: "Card account", value: account.name },
          { label: "Name", value: name },
          payload.issuer ? { label: "Issuer", value: payload.issuer } : null,
          { label: "Limit", value: formatMajor(creditLimit, account.currencyCode) },
          { label: "Closing day", value: String(args.closingDay) },
          { label: "Due day", value: String(args.dueDay) },
          { label: "Paid from", value: paidFrom?.name ?? "Not set" },
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const card = await createCreditCardCore(ctx.userId, payload as CreateCreditCardInput);
      return completed("Credit card added", `${card.name} (id ${card.id})`);
    },
  }),

  write({
    name: "update_credit_card",
    title: "Edit credit card",
    description:
      "Fix a card's name, issuer, credit limit (major units, in the card's currency), closing day, due day or paying account (paidFrom: a bank/cash/wallet account name, or null to clear) — the card screen's 'Edit'. Only the fields you pass change; the currency cannot be changed. " +
      "Every derived number depends on these: available limit = limit − amount owed; the closing day decides which statement each future purchase/instalment lands on and the due day when that statement leaves cash in the forecast. Already-registered instalments keep the cycles they were assigned to.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid().describe("card id from get_credit_cards"),
      name: z.string().min(1).max(120).optional(),
      issuer: z.string().max(120).optional(),
      creditLimit: z.number().nonnegative().optional().describe("major units"),
      closingDay: dayOfMonth.optional(),
      dueDay: dayOfMonth.optional(),
      paidFrom: z.string().min(1).nullable().optional().describe("settling account name, or null to clear"),
    }),
    async prepare(ctx, args) {
      const { card } = await findCard(ctx.userId, args.id);
      const paidFrom =
        args.paidFrom == null
          ? args.paidFrom
          : await resolveAccountOfType(ctx.userId, args.paidFrom, LIQUID_TYPES, "bank, cash or wallet account");
      const changes: UpdateCreditCardInput = {};
      if (args.name !== undefined) changes.name = args.name;
      if (args.issuer !== undefined) changes.issuer = args.issuer;
      if (args.creditLimit !== undefined) changes.creditLimit = args.creditLimit;
      if (args.closingDay !== undefined) changes.defaultClosingDay = args.closingDay;
      if (args.dueDay !== undefined) changes.defaultDueDay = args.dueDay;
      if (paidFrom !== undefined) changes.paymentAccountId = paidFrom?.id ?? null;
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      return {
        payload: { id: card.id, changes },
        title: "Update credit card?",
        summary: card.name,
        fields: compact([
          changes.name !== undefined && { label: "Name", value: changes.name },
          changes.issuer !== undefined && { label: "Issuer", value: changes.issuer || "None" },
          changes.creditLimit !== undefined && {
            label: "Limit",
            value: `${formatMoney(card.creditLimitMinor, card.currencyCode)} → ${formatMajor(changes.creditLimit, card.currencyCode)}`,
          },
          changes.defaultClosingDay !== undefined && {
            label: "Closing day",
            value: `${card.defaultClosingDay} → ${changes.defaultClosingDay}`,
          },
          changes.defaultDueDay !== undefined && {
            label: "Due day",
            value: `${card.defaultDueDay} → ${changes.defaultDueDay}`,
          },
          paidFrom !== undefined && { label: "Paid from", value: paidFrom?.name ?? "Not set" },
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdateCreditCardInput };
      await updateCreditCardCore(ctx.userId, p.id, p.changes);
      return completed("Credit card updated", `id ${p.id}`);
    },
  }),

  write({
    name: "archive_credit_card",
    title: "Archive credit card",
    description:
      "Archive (deactivate) a card — the card screen's 'Archive'. Nothing is deleted: its purchases, instalments and billing cycles stay auditable, and restore_credit_card brings it back. " +
      "Forecast effect: an archived card leaves get_credit_cards, its statements stop being projected, and bills on its account are projected again as cash outflows on their due dates.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid().describe("card id from get_credit_cards") }),
    async prepare(ctx, args) {
      const { card, archived } = await findCard(ctx.userId, args.id);
      if (archived) throw new Error(`${card.name} is already archived.`);
      return {
        payload: { id: card.id },
        title: "Archive credit card?",
        summary: `${card.name} will stop being tracked; its history is kept.`,
        fields: [
          { label: "Card", value: card.name },
          { label: "Limit", value: formatMoney(card.creditLimitMinor, card.currencyCode) },
        ],
        warning: "Its future statements leave the forecast until it is restored.",
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await archiveCreditCardCore(ctx.userId, p.id);
      return completed("Credit card archived", `id ${p.id}`);
    },
  }),

  write({
    name: "restore_credit_card",
    title: "Restore credit card",
    description:
      "Bring an archived card back (the Cards screen's archived list). Its statements and card-account bills are projected again exactly as before archiving. The id is the archived card's id (returned when it was archived or created).",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const { card, archived } = await findCard(ctx.userId, args.id);
      if (!archived) throw new Error(`${card.name} is not archived.`);
      return {
        payload: { id: card.id },
        title: "Restore credit card?",
        summary: card.name,
        fields: [{ label: "Card", value: card.name }],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await restoreCreditCardCore(ctx.userId, p.id);
      return completed("Credit card restored", `id ${p.id}`);
    },
  }),

  write({
    name: "register_card_purchase",
    title: "Register card purchase",
    description:
      "Register a new purchase on a card, optionally in instalments (the card screen's 'New purchase'). Creates, atomically: one posted expense transaction for the FULL amount on the card's account dated purchaseDate (the economic expense, PRD R4), an instalment plan, and one instalment per parcel. " +
      "Parcels: each is round(total / installments) in minor units and the last one absorbs the rounding remainder, so they always sum to the total exactly; parcel 1 lands on the statement the card's closing day puts purchaseDate in, each later parcel on the following month's statement, each due on the card's due day (billing cycles are opened as needed). " +
      "Those parcels then flow into the forecast through the statement settlements, never as a second expense. amount is the total in major units of the card's currency; installments defaults to 1; purchaseDate defaults to today; category is a category name. " +
      "Use this only for a purchase happening now: an imported card's past purchases are already in the ledger, and registering one again would double it. The result lists every parcel's number, amount and expected date.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      cardId: z.string().uuid().describe("card id from get_credit_cards"),
      description: z.string().min(1).max(200),
      amount: z.number().positive().describe("total, major units"),
      installments: z.number().int().positive().default(1),
      purchaseDate: isoDateSchema.optional().describe("yyyy-MM-dd, defaults to today"),
      category: z.string().min(1).optional().describe("category name"),
      merchant: z.string().max(120).optional(),
    }),
    async prepare(ctx, args) {
      const { card, archived } = await findCard(ctx.userId, args.cardId);
      const category = args.category ? await resolveNamedCategory(ctx.userId, args.category) : null;
      const purchaseDate = args.purchaseDate ?? todayIso();
      const payload: RegisterCardPurchaseInput = {
        creditCardId: card.id,
        purchaseDate,
        totalAmount: args.amount,
        totalInstallments: args.installments,
        description: args.description,
        merchant: args.merchant,
        categoryId: category?.id ?? null,
      };
      return {
        payload,
        title: "Register card purchase?",
        summary: `${args.description} on ${card.name}`,
        fields: compact([
          { label: "Card", value: card.name },
          { label: "Description", value: args.description },
          { label: "Total", value: formatMajor(args.amount, card.currencyCode) },
          { label: "Installments", value: String(args.installments) },
          { label: "Purchase date", value: purchaseDate },
          { label: "Category", value: category?.name ?? "Uncategorised" },
          args.merchant ? { label: "Merchant", value: args.merchant } : null,
        ]),
        warning: archived
          ? `${card.name} is archived, so these instalments will not reach the forecast until it is restored.`
          : "Only for a new purchase: if this purchase was already imported, registering it doubles the expense.",
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as RegisterCardPurchaseInput;
      const result = await registerCardPurchaseCore(ctx.userId, p);
      const currency = result.transaction.currencyCode;
      const schedule = result.installments
        .map((item) => `${item.number}/${p.totalInstallments} ${formatMoney(item.amountMinor, currency)} (${item.amountMinor} minor) due ${item.expectedAt}`)
        .join("; ");
      return completed(
        "Card purchase registered",
        `${result.transaction.description}: ${formatMoney(result.purchase.totalAmountMinor, currency)} (purchase id ${result.purchase.id}, transaction id ${result.transaction.id}). Parcels: ${schedule}.`,
      );
    },
  }),

  write({
    name: "delete_card_purchase",
    title: "Delete card purchase",
    description:
      "Undo a registered card purchase whole (the card screen's purchase list delete): permanently deletes its expense transaction together with its instalment plan and every instalment, so none of its parcels reach future statements or the forecast any more, and recomputes the card account's balance. Billing cycles are kept (they are shared). " +
      "purchaseId is the id returned by register_card_purchase. Cannot be undone. Deleting the same expense from the transactions screen is different — that soft-deletes only the transaction and leaves the parcels projecting.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ purchaseId: z.string().uuid() }),
    async prepare(ctx, args) {
      const { active, archived } = await allCards(ctx.userId);
      for (const card of [...active, ...archived]) {
        const purchase = (await listCardPurchases(ctx.userId, card.id)).find((row) => row.id === args.purchaseId);
        if (!purchase) continue;
        const parcels = purchase.installmentPlans[0]?.totalInstallments ?? 1;
        return {
          payload: { purchaseId: purchase.id },
          title: "Delete card purchase?",
          summary: `${purchase.transaction.description} and its ${parcels} instalment(s) will be removed from ${card.name}.`,
          fields: [
            { label: "Card", value: card.name },
            { label: "Purchase", value: purchase.transaction.description },
            { label: "Date", value: purchase.purchaseDate },
            { label: "Total", value: formatMoney(purchase.totalAmountMinor, card.currencyCode) },
            { label: "Installments", value: String(parcels) },
          ],
          affectedCount: parcels + 1,
          warning: "This permanently deletes the expense and every instalment it scheduled.",
          undoable: false,
        };
      }
      throw new Error("Card purchase not found.");
    },
    async execute(ctx, payload) {
      const p = payload as { purchaseId: string };
      await deleteCardPurchaseCore(ctx.userId, p.purchaseId);
      return completed("Card purchase deleted", `id ${p.purchaseId}`);
    },
  }),

  write({
    name: "reconcile_billing_cycle",
    title: "Reconcile statement",
    description:
      "Confirm a recorded billing cycle against the real statement (PRD §29; the card screen's reconcile button). Identify the cycle by cardId plus statementMonth (yyyy-MM) or by cycleId, as listed by get_card_statement; only cycles with source 'recorded' can be reconciled (derived ones have no stored cycle, open_finance ones are already confirmed by the institution). " +
      "confirmedTotal is the statement total in major units of the card's currency. The engine compares it with what it billed to this cycle (sum of its non-cancelled instalments, shown as 'Billed' in the confirmation): if they match, the cycle takes the requested status (default 'closed', like the screen; 'paid' also removes it from the forecast as a settled fact); if they differ by anything — a fee, interest, a purchase the system never saw — the cycle is forced to 'needs_review' whatever status you asked for. " +
      "The confirmed total then becomes the cycle's total. The result returns status, expected, confirmed and discrepancy (confirmed − expected) in minor units.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      cardId: z.string().uuid(),
      statementMonth: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("yyyy-MM"),
      cycleId: z.string().uuid().optional(),
      confirmedTotal: z.number().nonnegative().describe("major units"),
      status: z.enum(["closed", "paid"]).default("closed"),
    }),
    async prepare(ctx, args) {
      if (!args.statementMonth && !args.cycleId) throw new Error("Pass statementMonth or cycleId.");
      const statement = await getCardStatement(ctx.userId, args.cardId);
      if (!statement) throw new Error("Credit card not found.");
      const cycle = statement.cycles.find((c) =>
        args.cycleId ? c.id === args.cycleId : c.statementMonth === args.statementMonth,
      );
      if (!cycle) throw new Error("No billing cycle matches on this card.");
      if (cycle.source === "derived") {
        throw new Error(
          `The ${cycle.statementMonth} statement is derived from ledger transactions; there is no recorded cycle to reconcile.`,
        );
      }
      if (cycle.source === "open_finance") {
        throw new Error(`The ${cycle.statementMonth} statement was already confirmed by the institution.`);
      }
      const currency = statement.card.currencyCode;
      const payload: { cycleId: string; input: ReconcileBillingCycleInput } = {
        cycleId: cycle.id,
        input: { confirmedTotal: args.confirmedTotal, status: args.status },
      };
      return {
        payload,
        title: "Reconcile statement?",
        summary: `${statement.card.name} · ${cycle.statementMonth}`,
        fields: [
          { label: "Card", value: statement.card.name },
          { label: "Statement", value: cycle.statementMonth },
          { label: "Billed by the system", value: formatMoney(cycle.chargesMinor, currency) },
          { label: "Statement total", value: formatMajor(args.confirmedTotal, currency) },
          { label: "Status if it matches", value: args.status },
        ],
        warning: cycle.isReconciled
          ? `This cycle was already reconciled at ${formatMoney(cycle.totalMinor, currency)}; this replaces it.`
          : undefined,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { cycleId: string; input: ReconcileBillingCycleInput };
      const r = await reconcileBillingCycleCore(ctx.userId, p.cycleId, p.input);
      const title = r.status === "needs_review" ? "Statement flagged for review" : "Statement reconciled";
      return completed(
        title,
        `status ${r.status}; expected ${r.expectedMinor}, confirmed ${r.confirmedTotalMinor}, discrepancy ${r.discrepancyMinor} (minor units)`,
      );
    },
  }),
];

/* ── bills ──────────────────────────────────────────────────────────────── */

const BILL_FORECAST_NOTE =
  "Forecast effect: an active bill in your default currency is projected from nextDueDate, repeating every recurrence period. A fixed bill always projects at its amount (HIGH confidence); a variable one projects at the amount of the latest transaction linked to it (MEDIUM) and falls back to the typed amount until such a payment exists (LOW). " +
  "If its account is a tracked credit card's account, it is not a cash event on its due date: it is charged to that card and leaves cash only when the card's statement settles. With a category, its occurrences count as committed spending of any budget covering that category, which lowers that budget's remaining estimate.";

const billTools: WriteTool[] = [
  write({
    name: "create_bill",
    title: "Add bill",
    description:
      "Create a repeating bill (the Bills screen's 'New bill'). amount is the expected amount in major units; currencyCode defaults to your default currency; recurrence weekly|monthly|quarterly|yearly (default monthly); amountStrategy fixed (same amount every time, default) or variable (changes each time, e.g. electricity); nextDueDate defaults to today and its day-of-month becomes the bill's due day; account and category are names; notes optional. " +
      BILL_FORECAST_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      name: z.string().min(1).max(120),
      amount: z.number().positive().describe("expected amount, major units"),
      currencyCode: currencyCodeInput.optional(),
      recurrence: recurrenceInput.default("monthly"),
      amountStrategy: amountStrategyInput.default("fixed"),
      nextDueDate: isoDateSchema.optional().describe("yyyy-MM-dd, defaults to today"),
      account: z.string().min(1).optional().describe("account name it is paid from"),
      category: z.string().min(1).optional().describe("category name"),
      notes: z.string().max(2000).optional(),
    }),
    async prepare(ctx, args) {
      const currencyCode = (args.currencyCode ?? ctx.currency).toUpperCase();
      const account = args.account ? await resolveNamedAccount(ctx.userId, args.account) : null;
      const category = args.category ? await resolveNamedCategory(ctx.userId, args.category) : null;
      const card = await activeCardOnAccount(ctx.userId, account?.id);
      const nextDueDate = args.nextDueDate ?? todayIso();
      const payload: CreateBillInput = {
        name: args.name,
        expectedAmount: args.amount,
        currencyCode,
        recurrence: args.recurrence,
        amountStrategy: args.amountStrategy,
        nextDueDate,
        accountId: account?.id ?? null,
        categoryId: category?.id ?? null,
        notes: args.notes,
      };
      return {
        payload,
        title: "Add bill?",
        summary: args.name,
        fields: compact([
          { label: "Name", value: args.name },
          { label: "Amount", value: `${formatMajor(args.amount, currencyCode)} (${args.amountStrategy})` },
          { label: "Repeats", value: args.recurrence },
          { label: "Next due", value: nextDueDate },
          { label: "Account", value: account?.name ?? "Not set" },
          card ? { label: "Settles via", value: `${card.name} statement` } : null,
          { label: "Category", value: category?.name ?? "Uncategorised" },
          args.notes ? { label: "Notes", value: args.notes } : null,
        ]),
        warning: currencyNotice(currencyCode, ctx.currency, "bill"),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const bill = await createBillCore(ctx.userId, payload as CreateBillInput);
      return completed("Bill added", `${bill.name} (id ${bill.id})`);
    },
  }),

  write({
    name: "update_bill",
    title: "Edit bill",
    description:
      "Change a bill by id (from get_upcoming_commitments or the bills list): name, amount (major units, in the bill's currency), recurrence, amountStrategy (fixed|variable), nextDueDate (its day becomes the due day), account/category (names, or null to clear), notes, and isActive (false pauses the bill: it stays listed but leaves the forecast and budget commitments; true resumes it) — every action the Bills screen offers (edit, pause/resume, mark as fixed/variable). Only the fields you pass change; the currency cannot be changed. " +
      BILL_FORECAST_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      amount: z.number().positive().optional().describe("major units"),
      recurrence: recurrenceInput.optional(),
      amountStrategy: amountStrategyInput.optional(),
      nextDueDate: isoDateSchema.optional(),
      account: z.string().min(1).nullable().optional().describe("account name, or null to clear"),
      category: z.string().min(1).nullable().optional().describe("category name, or null to clear"),
      notes: z.string().max(2000).optional(),
      isActive: z.boolean().optional(),
    }),
    async prepare(ctx, args) {
      const bill = await findBill(ctx.userId, args.id);
      const account =
        args.account == null ? args.account : await resolveNamedAccount(ctx.userId, args.account);
      const category =
        args.category == null ? args.category : await resolveNamedCategory(ctx.userId, args.category);
      const changes: UpdateBillInput = {};
      if (args.name !== undefined) changes.name = args.name;
      if (args.amount !== undefined) changes.expectedAmount = args.amount;
      if (args.recurrence !== undefined) changes.recurrence = args.recurrence;
      if (args.amountStrategy !== undefined) changes.amountStrategy = args.amountStrategy;
      if (args.nextDueDate !== undefined) changes.nextDueDate = args.nextDueDate;
      if (account !== undefined) changes.accountId = account?.id ?? null;
      if (category !== undefined) changes.categoryId = category?.id ?? null;
      if (args.notes !== undefined) changes.notes = args.notes;
      if (args.isActive !== undefined) changes.isActive = args.isActive;
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      const card = account ? await activeCardOnAccount(ctx.userId, account.id) : null;
      return {
        payload: { id: bill.id, changes },
        title: "Update bill?",
        summary: bill.name,
        fields: compact([
          changes.name !== undefined && { label: "Name", value: changes.name },
          changes.expectedAmount !== undefined && {
            label: "Amount",
            value: `${formatMoney(bill.expectedAmountMinor, bill.currencyCode)} → ${formatMajor(changes.expectedAmount, bill.currencyCode)}`,
          },
          changes.recurrence !== undefined && { label: "Repeats", value: changes.recurrence },
          changes.amountStrategy !== undefined && { label: "Amount strategy", value: changes.amountStrategy },
          changes.nextDueDate !== undefined && { label: "Next due", value: changes.nextDueDate },
          account !== undefined && { label: "Account", value: account?.name ?? "Not set" },
          card ? { label: "Settles via", value: `${card.name} statement` } : null,
          category !== undefined && { label: "Category", value: category?.name ?? "Uncategorised" },
          changes.notes !== undefined && { label: "Notes", value: changes.notes || "None" },
          changes.isActive !== undefined && { label: "State", value: changes.isActive ? "Active" : "Paused" },
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdateBillInput };
      await updateBillCore(ctx.userId, p.id, p.changes);
      return completed("Bill updated", `id ${p.id}`);
    },
  }),

  write({
    name: "delete_bill",
    title: "Delete bill",
    description:
      "Permanently delete a bill by id. Its future occurrences leave the forecast and budget commitments; transactions that already paid it stay in the ledger. To stop it temporarily, use update_bill with isActive=false instead. Cannot be undone.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const bill = await findBill(ctx.userId, args.id);
      return {
        payload: { id: bill.id },
        title: "Delete bill?",
        summary: `${bill.name} will be deleted.`,
        fields: [
          { label: "Bill", value: bill.name },
          { label: "Amount", value: formatMoney(bill.expectedAmountMinor, bill.currencyCode) },
          { label: "Next due", value: bill.nextDueDate },
        ],
        warning: "This permanently deletes the bill.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await deleteBillCore(ctx.userId, p.id);
      return completed("Bill deleted", `id ${p.id}`);
    },
  }),

  write({
    name: "mark_bill_paid",
    title: "Mark bill paid",
    description:
      "Mark a bill's current occurrence paid (the Bills screen's 'Mark paid'). Always: lastPaidDate = paymentDate (default today) and nextDueDate advances one recurrence period (shown in the confirmation), so this occurrence leaves the forecast. Three mutually exclusive forms: " +
      "(1) transactionId — link an existing transaction as the payment (candidates from get_bill_payment_candidates); nothing new is created, and a variable bill will project at that transaction's amount next time. Re-sending the same transactionId is a no-op. " +
      "(2) amount (major units, what was actually paid) with optional paymentDate — creates a posted expense on the bill's account, dated paymentDate, in the bill's category and linked to the bill, and recomputes that account's balance; requires the bill to have an account. Use this for a variable bill with no matching transaction. " +
      "(3) neither — the plain one-click case for a fixed bill: only the dates move. Never pass both transactionId and amount.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid().describe("bill id"),
      transactionId: z.string().uuid().optional(),
      amount: z.number().positive().optional().describe("major units"),
      paymentDate: isoDateSchema.optional().describe("yyyy-MM-dd, defaults to today"),
    }),
    async prepare(ctx, args) {
      if (args.transactionId && args.amount !== undefined) {
        throw new Error("Pick a transaction or enter an amount, not both.");
      }
      const bill = await findBill(ctx.userId, args.id);
      if (args.amount !== undefined && !bill.accountId) {
        throw new Error("This bill has no account, so an amount can't be recorded as a transaction; link a transaction instead.");
      }
      const tx = args.transactionId ? await getTransaction(ctx.userId, args.transactionId) : null;
      if (args.transactionId && !tx) throw new Error("Transaction not found.");
      const payload: MarkBillPaidInput = {
        billId: bill.id,
        transactionId: args.transactionId,
        amount: args.amount,
        paymentDate: args.paymentDate,
      };
      return {
        payload,
        title: "Mark bill paid?",
        summary: bill.name,
        fields: compact([
          { label: "Bill", value: bill.name },
          tx && {
            label: "Linked transaction",
            value: `${tx.description} · ${tx.date} · ${formatMoney(Math.abs(tx.amountMinor), tx.currencyCode)}`,
          },
          args.amount !== undefined && {
            label: "New expense",
            value: `${formatMajor(args.amount, bill.currencyCode)} on ${bill.account?.name ?? "its account"}`,
          },
          { label: "Paid on", value: args.paymentDate ?? todayIso() },
          { label: "Next due", value: `${bill.nextDueDate} → ${advanceOnePeriod(bill)}` },
        ]),
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as MarkBillPaidInput;
      await markBillPaidCore(ctx.userId, p);
      return completed("Bill marked paid", `id ${p.billId}`);
    },
  }),
];

/* ── recurring ──────────────────────────────────────────────────────────── */

const RECURRING_NOTE =
  "Effects: on each nextRunDate a background job drafts a pending transaction into the review inbox (nothing posts without review) and moves nextRunDate one interval ahead. While active and in your default currency, income and expense items are also projected in the forecast from nextRunDate every interval (HIGH confidence); transfers between your own accounts net to zero and are never projected. A categorised expense also counts as committed spending of budgets covering that category.";

const recurringTools: WriteTool[] = [
  write({
    name: "create_recurring",
    title: "Add recurring transaction",
    description:
      "Create a recurring income, expense or transfer (the Recurring screen's 'New'). account (name) is where it posts; a transfer also needs transferAccount (destination account name). amount is positive, in major units — the sign comes from type. currencyCode defaults to your default currency, interval weekly|monthly|quarterly|yearly (default monthly), nextRunDate defaults to today, description defaults to name, category is a category name. " +
      RECURRING_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      name: z.string().min(1).max(120),
      type: recurringTypeInput,
      account: z.string().min(1).describe("account name"),
      transferAccount: z.string().min(1).optional().describe("destination account name (transfers only)"),
      category: z.string().min(1).optional(),
      amount: z.number().positive().describe("major units"),
      currencyCode: currencyCodeInput.optional(),
      description: z.string().min(1).max(300).optional(),
      interval: recurrenceInput.default("monthly"),
      nextRunDate: isoDateSchema.optional(),
    }),
    async prepare(ctx, args) {
      const account = await resolveNamedAccount(ctx.userId, args.account);
      if (args.type === "transfer" && !args.transferAccount) throw new Error("A transfer needs transferAccount.");
      const transferAccount =
        args.type === "transfer" && args.transferAccount
          ? await resolveNamedAccount(ctx.userId, args.transferAccount)
          : null;
      const category = args.category ? await resolveNamedCategory(ctx.userId, args.category) : null;
      const currencyCode = (args.currencyCode ?? ctx.currency).toUpperCase();
      const nextRunDate = args.nextRunDate ?? todayIso();
      const payload: CreateRecurringInput = {
        name: args.name,
        type: args.type,
        accountId: account.id,
        transferAccountId: transferAccount?.id ?? null,
        categoryId: category?.id ?? null,
        amount: args.amount,
        currencyCode,
        description: args.description ?? args.name,
        interval: args.interval,
        nextRunDate,
      };
      return {
        payload,
        title: "Add recurring transaction?",
        summary: args.name,
        fields: compact([
          { label: "Name", value: args.name },
          { label: "Type", value: args.type },
          { label: "Amount", value: formatMajor(args.amount, currencyCode) },
          { label: args.type === "transfer" ? "From" : "Account", value: account.name },
          transferAccount && { label: "To", value: transferAccount.name },
          { label: "Category", value: category?.name ?? "Uncategorised" },
          { label: "Every", value: args.interval },
          { label: "Next run", value: nextRunDate },
        ]),
        warning: args.type === "transfer" ? undefined : currencyNotice(currencyCode, ctx.currency, "recurring item"),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const item = await createRecurringCore(ctx.userId, payload as CreateRecurringInput);
      return completed("Recurring transaction added", `${item.name} (id ${item.id})`);
    },
  }),

  write({
    name: "update_recurring",
    title: "Edit recurring transaction",
    description:
      "Change a recurring item by id (from get_recurring_transactions): name, type, account, transferAccount (required when the result is a transfer; ignored otherwise), category (name or null), amount (positive, major units; sign follows type), description, interval, nextRunDate. Only the fields you pass change; the currency cannot be changed here, as on the screen. Pausing is set_recurring_active. " +
      RECURRING_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      type: recurringTypeInput.optional(),
      account: z.string().min(1).optional(),
      transferAccount: z.string().min(1).nullable().optional(),
      category: z.string().min(1).nullable().optional(),
      amount: z.number().positive().optional().describe("major units"),
      description: z.string().min(1).max(300).optional(),
      interval: recurrenceInput.optional(),
      nextRunDate: isoDateSchema.optional(),
    }),
    async prepare(ctx, args) {
      const item = await findRecurring(ctx.userId, args.id);
      const account = args.account ? await resolveNamedAccount(ctx.userId, args.account) : undefined;
      const transferAccount =
        args.transferAccount == null
          ? args.transferAccount
          : await resolveNamedAccount(ctx.userId, args.transferAccount);
      const category =
        args.category == null ? args.category : await resolveNamedCategory(ctx.userId, args.category);
      const type = args.type ?? item.type;
      const changes: UpdateRecurringInput = {};
      if (args.name !== undefined) changes.name = args.name;
      if (args.type !== undefined) changes.type = args.type;
      if (account) changes.accountId = account.id;
      if (transferAccount !== undefined) changes.transferAccountId = transferAccount?.id ?? null;
      if (category !== undefined) changes.categoryId = category?.id ?? null;
      if (args.amount !== undefined) changes.amount = args.amount;
      if (args.description !== undefined) changes.description = args.description;
      if (args.interval !== undefined) changes.interval = args.interval;
      if (args.nextRunDate !== undefined) changes.nextRunDate = args.nextRunDate;
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      const destinationId =
        transferAccount === undefined ? item.transferAccountId : (transferAccount?.id ?? null);
      if (type === "transfer" && !destinationId) throw new Error("A transfer needs transferAccount.");
      // The schema's transfer check reads only the payload, so carry the
      // existing destination when the type is set to transfer without naming it.
      if (args.type === "transfer") changes.transferAccountId = destinationId;
      return {
        payload: { id: item.id, changes },
        title: "Update recurring transaction?",
        summary: item.name,
        fields: compact([
          changes.name !== undefined && { label: "Name", value: changes.name },
          changes.type !== undefined && { label: "Type", value: `${item.type} → ${changes.type}` },
          account && { label: "Account", value: account.name },
          transferAccount !== undefined && type === "transfer" && {
            label: "To",
            value: transferAccount?.name ?? "Not set",
          },
          category !== undefined && { label: "Category", value: category?.name ?? "Uncategorised" },
          changes.amount !== undefined && {
            label: "Amount",
            value: `${formatMoney(Math.abs(item.amountMinor), item.currencyCode)} → ${formatMajor(changes.amount, item.currencyCode)}`,
          },
          changes.description !== undefined && { label: "Description", value: changes.description },
          changes.interval !== undefined && { label: "Every", value: changes.interval },
          changes.nextRunDate !== undefined && { label: "Next run", value: changes.nextRunDate },
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdateRecurringInput };
      await updateRecurringCore(ctx.userId, p.id, p.changes);
      return completed("Recurring transaction updated", `id ${p.id}`);
    },
  }),

  write({
    name: "set_recurring_active",
    title: "Pause / resume recurring",
    description:
      "Pause (isActive=false) or resume (isActive=true) a recurring item by id. A paused item drafts no inbox transactions and is not projected in the forecast or counted as budget commitment; resuming restores both from its current nextRunDate (if that date has passed, the job drafts every missed period up to today, at most 24).",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid(), isActive: z.boolean() }),
    async prepare(ctx, args) {
      const item = await findRecurring(ctx.userId, args.id);
      return {
        payload: { id: item.id, isActive: args.isActive },
        title: args.isActive ? "Resume recurring?" : "Pause recurring?",
        summary: item.name,
        fields: [
          { label: "Item", value: item.name },
          { label: "Next run", value: item.nextRunDate },
          { label: "State", value: args.isActive ? "Active" : "Paused" },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; isActive: boolean };
      await setRecurringActiveCore(ctx.userId, p.id, p.isActive);
      return completed(p.isActive ? "Recurring resumed" : "Recurring paused", `id ${p.id}`);
    },
  }),

  write({
    name: "delete_recurring",
    title: "Delete recurring",
    description:
      "Permanently delete a recurring item by id: it stops drafting transactions and leaves the forecast. Transactions it already drafted stay in the ledger/inbox. To stop it temporarily use set_recurring_active instead. Cannot be undone.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const item = await findRecurring(ctx.userId, args.id);
      return {
        payload: { id: item.id },
        title: "Delete recurring transaction?",
        summary: `${item.name} will be deleted.`,
        fields: [
          { label: "Item", value: item.name },
          { label: "Amount", value: formatMoney(item.amountMinor, item.currencyCode) },
          { label: "Every", value: item.interval },
        ],
        warning: "This permanently deletes the recurring item.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await deleteRecurringCore(ctx.userId, p.id);
      return completed("Recurring transaction deleted", `id ${p.id}`);
    },
  }),
];

/* ── budgets ────────────────────────────────────────────────────────────── */

const BUDGET_NOTE =
  "Forecast effect: for every month in the horizon the budget's planned amount is the ceiling of its variable-spending estimate: remaining = max(0, planned − spent in its categories that month − commitments already projected in them that month, i.e. bills, recurring expenses and card parcels). That remaining amount is spread over the month's remaining days as LOW-confidence 'budget_estimate' outflows, which lowers the projected balance and safe-to-spend. " +
  "The planned amount is stored for the current month; later months reuse the latest planned amount (and a monthly job copies it forward). Only budgets in your default currency feed the forecast.";

async function resolveCategoryNames(userId: string, names: string[]) {
  const resolved = await Promise.all(names.map((name) => resolveNamedCategory(userId, name)));
  return [...new Map(resolved.map((category) => [category.id, category])).values()];
}

const budgetTools: WriteTool[] = [
  write({
    name: "create_budget",
    title: "Create budget",
    description:
      "Create a monthly budget (the Budgets screen's 'New budget'). amount is the planned spending per month in major units; categories is a non-empty list of category names whose expenses count against it; currencyCode defaults to your default currency. " +
      BUDGET_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      name: z.string().min(1).max(80),
      amount: z.number().positive().describe("planned per month, major units"),
      categories: z.array(z.string().min(1)).min(1).describe("category names"),
      currencyCode: currencyCodeInput.optional(),
    }),
    async prepare(ctx, args) {
      const categories = await resolveCategoryNames(ctx.userId, args.categories);
      const currencyCode = (args.currencyCode ?? ctx.currency).toUpperCase();
      const payload: CreateBudgetInput = {
        name: args.name,
        categoryIds: categories.map((category) => category.id),
        plannedAmount: args.amount,
        currencyCode,
      };
      return {
        payload,
        title: "Create budget?",
        summary: args.name,
        fields: [
          { label: "Name", value: args.name },
          { label: "Planned / month", value: formatMajor(args.amount, currencyCode) },
          { label: "Categories", value: categories.map((category) => category.name).join(", ") },
        ],
        warning: currencyNotice(currencyCode, ctx.currency, "budget"),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const budget = await createBudgetCore(ctx.userId, payload as CreateBudgetInput);
      return completed("Budget created", `${budget.name} (id ${budget.id})`);
    },
  }),

  write({
    name: "update_budget",
    title: "Edit budget",
    description:
      "Change a budget by id (from get_budgets): name, amount (planned per month, major units, in the budget's own currency — it never changes), and categories (names; REPLACES the whole set). A new amount applies to the current month and, by roll-forward, to later months; past months keep theirs. Only the fields you pass change. " +
      BUDGET_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(80).optional(),
      amount: z.number().positive().optional().describe("planned per month, major units"),
      categories: z.array(z.string().min(1)).min(1).optional().describe("category names; replaces the set"),
    }),
    async prepare(ctx, args) {
      const budget = await findBudget(ctx.userId, args.id);
      const categories = args.categories ? await resolveCategoryNames(ctx.userId, args.categories) : undefined;
      const changes: UpdateBudgetInput = {};
      if (args.name !== undefined) changes.name = args.name;
      if (args.amount !== undefined) changes.plannedAmount = args.amount;
      if (categories) changes.categoryIds = categories.map((category) => category.id);
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      const latest = budget.periods.at(-1);
      const currency = latest?.currencyCode ?? ctx.currency;
      return {
        payload: { id: budget.id, changes },
        title: "Update budget?",
        summary: budget.name,
        fields: compact([
          changes.name !== undefined && { label: "Name", value: changes.name },
          changes.plannedAmount !== undefined && {
            label: "Planned / month",
            value: `${latest ? formatMoney(latest.plannedAmountMinor, currency) : "—"} → ${formatMajor(changes.plannedAmount, currency)}`,
          },
          categories && {
            label: "Categories",
            value: `${budget.budgetCategories.map((bc) => bc.category.name).join(", ")} → ${categories.map((c) => c.name).join(", ")}`,
          },
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdateBudgetInput };
      await updateBudgetCore(ctx.userId, p.id, p.changes);
      return completed("Budget updated", `id ${p.id}`);
    },
  }),

  write({
    name: "archive_budget",
    title: "Archive budget",
    description:
      "Archive a budget by id. Its periods and history are kept, but it leaves get_budgets and stops feeding the forecast's budget estimate (so projected balance and safe-to-spend rise by whatever it was still reserving). restore_budget brings it back.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const budget = await findBudget(ctx.userId, args.id);
      if (budget.isArchived) throw new Error(`${budget.name} is already archived.`);
      return {
        payload: { id: budget.id },
        title: "Archive budget?",
        summary: budget.name,
        fields: [{ label: "Budget", value: budget.name }],
        warning: "Its estimate leaves the forecast until it is restored.",
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await archiveBudgetCore(ctx.userId, p.id);
      return completed("Budget archived", `id ${p.id}`);
    },
  }),

  write({
    name: "restore_budget",
    title: "Restore budget",
    description:
      "Bring an archived budget back by id (or by exact name among archived budgets). It reappears in get_budgets and its planned amount feeds the forecast estimate again.",
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid().optional(),
      name: z.string().min(1).optional().describe("archived budget name, if the id is unknown"),
    }),
    async prepare(ctx, args) {
      const archived = await listArchivedBudgets(ctx.userId);
      const budget = args.id
        ? archived.find((row) => row.id === args.id)
        : archived.find((row) => row.name.toLowerCase() === args.name?.toLowerCase());
      if (!budget) {
        throw new Error(
          `No archived budget matches. Archived: ${archived.map((row) => `${row.name} (${row.id})`).join(", ") || "none"}.`,
        );
      }
      return {
        payload: { id: budget.id },
        title: "Restore budget?",
        summary: budget.name,
        fields: [{ label: "Budget", value: budget.name }],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await restoreBudgetCore(ctx.userId, p.id);
      return completed("Budget restored", `id ${p.id}`);
    },
  }),
];

/* ── goals ──────────────────────────────────────────────────────────────── */

const GOAL_NOTE =
  "Goals are tracking only: they move no money, create no transaction, and do not enter the forecast or safe-to-spend. The linked account is informational.";

const goalTools: WriteTool[] = [
  write({
    name: "create_goal",
    title: "Create goal",
    description:
      "Create a savings goal (the Goals screen's 'New goal'). targetAmount and currentAmount (already saved, default 0) are major units; currencyCode defaults to your default currency; account is an optional account name the goal is saved in; targetDate yyyy-MM-dd optional. " +
      GOAL_NOTE,
    risk: "write",
    requiredScope: "goals:write",
    input: z.object({
      name: z.string().min(1).max(120),
      targetAmount: z.number().positive(),
      currentAmount: z.number().min(0).default(0),
      currencyCode: currencyCodeInput.optional(),
      account: z.string().min(1).optional().describe("account name"),
      targetDate: isoDateSchema.optional(),
    }),
    async prepare(ctx, args) {
      const currencyCode = (args.currencyCode ?? ctx.currency).toUpperCase();
      const account = args.account ? await resolveNamedAccount(ctx.userId, args.account) : null;
      const payload: CreateGoalInput = {
        name: args.name,
        targetAmount: args.targetAmount,
        currentAmount: args.currentAmount,
        currencyCode,
        accountId: account?.id ?? null,
        targetDate: args.targetDate ?? null,
      };
      return {
        payload,
        title: "Create goal?",
        summary: args.name,
        fields: compact([
          { label: "Target", value: formatMajor(args.targetAmount, currencyCode) },
          args.currentAmount > 0 && { label: "Saved", value: formatMajor(args.currentAmount, currencyCode) },
          account && { label: "Account", value: account.name },
          args.targetDate ? { label: "By", value: args.targetDate } : null,
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const goal = await createGoalCore(ctx.userId, payload as CreateGoalInput);
      return completed("Goal created", `${goal.name} (id ${goal.id})`);
    },
  }),

  write({
    name: "update_goal",
    title: "Edit goal",
    description:
      "Fix a goal by id (from get_goals): name, targetAmount (major units), currencyCode, account (name or null), targetDate (yyyy-MM-dd or null). Never changes the saved amount — use contribute_to_goal. Changing currencyCode does not convert anything: the saved amount keeps its minor units, and the target is re-read in the new currency. Only the fields you pass change. " +
      GOAL_NOTE,
    risk: "write",
    requiredScope: "goals:write",
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      targetAmount: z.number().positive().optional(),
      currencyCode: currencyCodeInput.optional(),
      account: z.string().min(1).nullable().optional(),
      targetDate: isoDateSchema.nullable().optional(),
    }),
    async prepare(ctx, args) {
      const goal = await findGoal(ctx.userId, args.id);
      const account =
        args.account == null ? args.account : await resolveNamedAccount(ctx.userId, args.account);
      const changes: UpdateGoalInput = {};
      if (args.name !== undefined) changes.name = args.name;
      if (args.targetAmount !== undefined) changes.targetAmount = args.targetAmount;
      if (args.currencyCode !== undefined) changes.currencyCode = args.currencyCode.toUpperCase();
      if (account !== undefined) changes.accountId = account?.id ?? null;
      if (args.targetDate !== undefined) changes.targetDate = args.targetDate;
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      const currency = changes.currencyCode ?? goal.currencyCode;
      return {
        payload: { id: goal.id, changes },
        title: "Update goal?",
        summary: goal.name,
        fields: compact([
          changes.name !== undefined && { label: "Name", value: changes.name },
          changes.targetAmount !== undefined && {
            label: "Target",
            value: `${formatMoney(goal.targetAmountMinor, goal.currencyCode)} → ${formatMajor(changes.targetAmount, currency)}`,
          },
          changes.currencyCode !== undefined && { label: "Currency", value: changes.currencyCode },
          account !== undefined && { label: "Account", value: account?.name ?? "Not set" },
          changes.targetDate !== undefined && { label: "By", value: changes.targetDate ?? "No date" },
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdateGoalInput };
      await updateGoalCore(ctx.userId, p.id, p.changes);
      return completed("Goal updated", `id ${p.id}`);
    },
  }),

  write({
    name: "contribute_to_goal",
    title: "Contribute to goal",
    description:
      "Add money to a goal's saved amount (positive amount) or withdraw from it (negative), in major units of the goal's currency — the Goals screen's contribution box. new saved = max(0, saved + amount); the goal is stamped achieved the first time saved reaches the target, and un-stamped if it drops below again. Only the goal's counter changes. " +
      GOAL_NOTE,
    risk: "write",
    requiredScope: "goals:write",
    input: z.object({
      id: z.string().uuid(),
      amount: z.number().refine((n) => n !== 0, "Enter a non-zero contribution").describe("major units; negative withdraws"),
    }),
    async prepare(ctx, args) {
      const goal = await findGoal(ctx.userId, args.id);
      return {
        payload: { id: goal.id, amount: args.amount },
        title: args.amount > 0 ? "Add to goal?" : "Withdraw from goal?",
        summary: goal.name,
        fields: [
          { label: "Goal", value: goal.name },
          { label: args.amount > 0 ? "Add" : "Withdraw", value: formatMajor(Math.abs(args.amount), goal.currencyCode) },
          { label: "Saved now", value: formatMoney(goal.currentAmountMinor, goal.currencyCode) },
          { label: "Target", value: formatMoney(goal.targetAmountMinor, goal.currencyCode) },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; amount: number };
      const goal = await contributeToGoalCore(ctx.userId, p.id, p.amount);
      return completed(
        "Goal updated",
        `${goal.name}: saved ${formatMoney(goal.currentAmountMinor, goal.currencyCode)} of ${formatMoney(goal.targetAmountMinor, goal.currencyCode)} (${goal.currentAmountMinor}/${goal.targetAmountMinor} minor)${goal.achievedAt ? `, achieved ${goal.achievedAt}` : ""}`,
      );
    },
  }),

  write({
    name: "delete_goal",
    title: "Delete goal",
    description: "Permanently delete a goal by id, including its saved-amount counter. No money or transaction is affected. Cannot be undone.",
    risk: "sensitive",
    requiredScope: "goals:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const goal = await findGoal(ctx.userId, args.id);
      return {
        payload: { id: goal.id },
        title: "Delete goal?",
        summary: `${goal.name} will be deleted.`,
        fields: [
          { label: "Goal", value: goal.name },
          { label: "Saved", value: formatMoney(goal.currentAmountMinor, goal.currencyCode) },
          { label: "Target", value: formatMoney(goal.targetAmountMinor, goal.currencyCode) },
        ],
        warning: "This permanently deletes the goal.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await deleteGoalCore(ctx.userId, p.id);
      return completed("Goal deleted", `id ${p.id}`);
    },
  }),
];

/* ── reserves ───────────────────────────────────────────────────────────── */

const RESERVE_NOTE =
  "Effect: the sum of all ACTIVE hard reserves is the safe-to-spend floor — safe-to-spend is the room above it at the forecast's lowest point, and a plan or purchase that would take the projected balance below it is flagged as violating the hard reserve. Active soft reserves are not subtracted; purchase-plan simulations report when a plan dips into them, as a warning. Inactive reserves count for nothing. Reserve amounts are summed as stored without currency conversion, so keep them in your default currency.";

const reserveTools: WriteTool[] = [
  write({
    name: "create_financial_reserve",
    title: "Add reserve",
    description:
      "Create a financial reserve (the Reserves screen's 'New reserve'): name, kind hard|soft (default hard, like the screen), amount (major units, ≥ 0), currencyCode (defaults to your default currency). " +
      RESERVE_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      name: z.string().min(1).max(120),
      kind: reserveKindInput.default("hard"),
      amount: z.number().nonnegative().describe("major units"),
      currencyCode: currencyCodeInput.optional(),
    }),
    async prepare(ctx, args) {
      const currencyCode = (args.currencyCode ?? ctx.currency).toUpperCase();
      const payload: CreateFinancialReserveInput = {
        name: args.name,
        kind: args.kind,
        amount: args.amount,
        currencyCode,
        isActive: true,
      };
      return {
        payload,
        title: "Add reserve?",
        summary: args.name,
        fields: [
          { label: "Name", value: args.name },
          { label: "Kind", value: args.kind === "hard" ? "Hard (safe-to-spend floor)" : "Soft (warning only)" },
          { label: "Amount", value: formatMajor(args.amount, currencyCode) },
        ],
        warning:
          currencyCode === ctx.currency
            ? undefined
            : `Reserves are summed without conversion; a ${currencyCode} reserve is added to ${ctx.currency} figures as-is.`,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const reserve = await createFinancialReserveCore(ctx.userId, payload as CreateFinancialReserveInput);
      return completed("Reserve added", `${reserve.name} (id ${reserve.id})`);
    },
  }),

  write({
    name: "update_financial_reserve",
    title: "Edit reserve",
    description:
      "Change a reserve by id: name, kind (hard|soft), amount (major units, in the reserve's currency), isActive (false switches it off without deleting; true switches it back on) — the Reserves screen's edit and on/off toggle. Only the fields you pass change. " +
      RESERVE_NOTE,
    risk: "write",
    requiredScope: "plans:write",
    input: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(120).optional(),
      kind: reserveKindInput.optional(),
      amount: z.number().nonnegative().optional().describe("major units"),
      isActive: z.boolean().optional(),
    }),
    async prepare(ctx, args) {
      const reserve = await findReserve(ctx.userId, args.id);
      const { id, ...rest } = args;
      const changes: UpdateFinancialReserveInput = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change.");
      return {
        payload: { id, changes },
        title: "Update reserve?",
        summary: reserve.name,
        fields: compact([
          changes.name !== undefined && { label: "Name", value: changes.name },
          changes.kind !== undefined && { label: "Kind", value: `${reserve.kind} → ${changes.kind}` },
          changes.amount !== undefined && {
            label: "Amount",
            value: `${formatMoney(reserve.amountMinor, reserve.currencyCode)} → ${formatMajor(changes.amount, reserve.currencyCode)}`,
          },
          changes.isActive !== undefined && { label: "State", value: changes.isActive ? "Active" : "Off" },
        ]),
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdateFinancialReserveInput };
      await updateFinancialReserveCore(ctx.userId, p.id, p.changes);
      return completed("Reserve updated", `id ${p.id}`);
    },
  }),

  write({
    name: "delete_financial_reserve",
    title: "Delete reserve",
    description:
      "Permanently delete a reserve by id. A hard one stops raising the safe-to-spend floor. To keep it but switch it off, use update_financial_reserve with isActive=false. Cannot be undone.",
    risk: "sensitive",
    requiredScope: "plans:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const reserve = await findReserve(ctx.userId, args.id);
      return {
        payload: { id: reserve.id },
        title: "Delete reserve?",
        summary: `${reserve.name} will be deleted.`,
        fields: [
          { label: "Reserve", value: reserve.name },
          { label: "Kind", value: reserve.kind },
          { label: "Amount", value: formatMoney(reserve.amountMinor, reserve.currencyCode) },
        ],
        warning: "This permanently deletes the reserve.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      await deleteFinancialReserveCore(ctx.userId, p.id);
      return completed("Reserve deleted", `id ${p.id}`);
    },
  }),
];

/* ── balance snapshot ───────────────────────────────────────────────────── */

const snapshotTools: WriteTool[] = [
  write({
    name: "record_balance_snapshot",
    title: "Record balance",
    description:
      "Record the real balance of an account on a date (the account screen's 'Record balance'). account is an account name, balance is in major units of the account's currency (may be negative), observedAt defaults to today; recording again for the same account and date overwrites it. " +
      "Effect: for a liquid account (asset/cash/wallet, not archived) the most recent snapshot dated on or before today becomes the account's observed balance in get_position — replacing the ledger-derived balance — and therefore the opening balance of the forecast and of safe-to-spend. A manual snapshot is reported stale after 3 days (informational, never blocking). Snapshots on other account types (cards, loans) are stored but not used by the position; a future-dated one is ignored until its date.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      account: z.string().min(1).describe("account name"),
      balance: z.number().describe("major units"),
      observedAt: isoDateSchema.optional().describe("yyyy-MM-dd, defaults to today"),
    }),
    async prepare(ctx, args) {
      const account = await resolveNamedAccount(ctx.userId, args.account);
      const observedAt = args.observedAt ?? todayIso();
      const payload: UpsertBalanceSnapshotInput = {
        accountId: account.id,
        amount: args.balance,
        observedAt,
        source: "manual",
      };
      return {
        payload,
        title: "Record balance?",
        summary: account.name,
        fields: [
          { label: "Account", value: account.name },
          { label: "Balance", value: formatMajor(args.balance, account.currencyCode) },
          { label: "As of", value: observedAt },
        ],
        warning: LIQUID_TYPES.includes(account.type)
          ? observedAt > todayIso()
            ? "A future-dated balance is ignored by the position until that date."
            : undefined
          : `${account.name} is a ${account.type} account; its snapshot is stored but does not feed the position or forecast.`,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const snapshot = await upsertBalanceSnapshotCore(ctx.userId, payload as UpsertBalanceSnapshotInput);
      return completed("Balance recorded", `${snapshot.amountMinor} minor units as of ${snapshot.observedAt} (id ${snapshot.id})`);
    },
  }),
];

export const financeWritesTools: WriteTool[] = [
  ...cardTools,
  ...billTools,
  ...recurringTools,
  ...budgetTools,
  ...goalTools,
  ...reserveTools,
  ...snapshotTools,
];

/* ── reads that only exist to support a write ───────────────────────────── */

export const financeWritesReadTools: ReadTool[] = [
  read({
    name: "get_bill_payment_candidates",
    title: "Bill payment candidates",
    description:
      "Transactions that mark_bill_paid can link as a bill's payment — the same list the 'Mark paid' dialog offers. Returns expense transactions not yet linked to any bill and not deleted, on the bill's account (or on every account when the bill has none), newest first (by date, then creation), up to limit (default 15 like the dialog, max 100). " +
      "Each row: id, date, description, merchant, amountMinor (signed ledger amount in minor units, negative for an expense) and currency (the bill's currency, which the dialog formats them in).",
    requiredScope: "finance:read",
    input: z.object({
      billId: z.string().uuid(),
      limit: z.number().int().min(1).max(100).default(15),
    }),
    async execute(ctx, args) {
      const bill = await findBill(ctx.userId, args.billId);
      const rows = await listUnlinkedExpenseCandidates(ctx.userId, bill.accountId, args.limit);
      return {
        forModel: {
          bill: {
            id: bill.id,
            name: bill.name,
            expectedAmountMinor: bill.expectedAmountMinor,
            currency: bill.currencyCode,
            amountStrategy: bill.amountStrategy,
            account: bill.account?.name ?? null,
          },
          candidates: rows.map((row) => ({ ...row, currency: bill.currencyCode })),
        },
      };
    },
  }),
];
