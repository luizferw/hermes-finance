import "server-only";
import { z } from "zod";
import { formatMoney, todayIso } from "@kosh/domain";
import {
  getAccount,
  getAccountBalanceHistory,
  getAccountTransactions,
  getNetWorthSummary,
  listAccounts,
} from "@/modules/accounts/queries";
import {
  getFinancialYearSummary,
  getMonthlyFlows,
  getNetWorthSeries,
  getRecentCashflow,
} from "@/modules/reports/queries";
import {
  getInboxCount,
  getInboxItems,
  getRecentlyRejected,
  getTransaction,
  listTransactions,
} from "@/modules/transactions/queries";
import {
  transactionStatusSchema,
  transactionTypeSchema,
} from "@/modules/transactions/validators";
import { getRuleSuggestions, listRuleRuns, listRules } from "@/modules/rules/queries";
import { getPatternsView } from "@/modules/patterns/queries";
import { readConfidence } from "@/modules/confidence/queries";
import { listBills } from "@/modules/bills/queries";
import { listRecurring } from "@/modules/recurring/queries";
import { listGoals } from "@/modules/goals/queries";
import { listArchivedBudgets, listBudgetsWithProgress } from "@/modules/budgets/queries";
import { getImportFile, listImportFiles, listImportMappings } from "@/modules/imports/queries";
import { getUserSettings } from "@/modules/settings/queries";
import { getSystemHealth } from "@/modules/system/queries";
import {
  isOpenFinanceEnabled,
  listConnections,
  listLinkTargets,
  listSyncRuns,
} from "@/modules/open-finance/queries";
import { listCategories, listTags } from "@/modules/taxonomy/queries";
import { currencyWarningBlocks, isoDateSchema, monthLabel, read } from "./shared";
import type { ReadTool } from "../types";

/* ── helpers ────────────────────────────────────────────────────────────── */

const uuid = z.string().uuid();

/** Any account the user owns, archived included, by exact then partial name. */
async function findAccountByName(userId: string, name: string) {
  const accounts = await listAccounts(userId);
  const h = name.toLowerCase();
  const account =
    accounts.find((a) => a.name.toLowerCase() === h) ??
    accounts.find((a) => a.name.toLowerCase().includes(h));
  if (!account) throw new Error(`No account matching "${name}".`);
  return account;
}

async function findCategoryByName(userId: string, name: string) {
  const categories = await listCategories(userId);
  const h = name.toLowerCase();
  const category =
    categories.find((c) => c.name.toLowerCase() === h) ??
    categories.find((c) => c.name.toLowerCase().includes(h));
  if (!category) throw new Error(`No category matching "${name}".`);
  return category;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

/** Infinity (spending against a zero plan) does not survive JSON. */
function finiteOrNull(n: number) {
  return Number.isFinite(n) ? n : null;
}

function daysBetweenIso(fromIso: string, toIso: string) {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

const LEDGER_STATUSES_NOTE =
  "Only transactions in a ledger status (imported, reviewed, posted) count; pending and rejected ones and soft-deleted rows are excluded.";

const DUPLICATE_NOTE =
  "A suspected duplicate is an incoming row that matched an existing transaction on the same account: the same external id, the same import hash (account + date + amount + description), or — fuzzy — the same amount within one day. It is a hint for review, not a merge; the suspected original is returned so the two can be compared.";

const CONDITION_LABEL: Record<string, string> = {
  description_contains: "description contains",
  raw_text_contains: "raw text contains",
  amount_greater_than: "amount greater than",
  amount_less_than: "amount less than",
  amount_equals: "amount equals",
  account_is: "account is",
  transaction_type_is: "type is",
};

/* ── tools ──────────────────────────────────────────────────────────────── */

export const ledgerReadsTools: ReadTool[] = [
  /* ── transactions ──────────────────────────────────────────────────────── */

  read({
    name: "search_transactions",
    title: "Search transactions",
    description:
      "The Transactions page: the full ledger, newest first (by date, then creation time), with the same filters and pagination as the screen. Filters: q (case-insensitive substring of description, merchant or raw bank description — notes and narration are encrypted and cannot be searched), account (by accountId or account name; matches both the source account and the destination of a transfer, archived accounts included), category (categoryId or name), status, type, from/to (inclusive ISO dates), minAmount/maxAmount (major units, compared against the absolute amount, converted with a 2-decimal exponent exactly as the UI does). page/pageSize (pageSize up to 200, the UI uses 50). Each row has date, description, merchant, raw description, notes, category, account, transfer target account (transfers only), status, type, signed amount in integer minor units (negative = money out of the source account) with its currency, and tags. total is the count of every row matching the filters, not just this page. Rows of every status are returned unless status is set; rejected and pending rows do not count toward balances.",
    requiredScope: "finance:read",
    input: z.object({
      q: z.string().max(200).optional().describe("substring of description, merchant or raw description"),
      text: z.string().max(200).optional().describe("alias of q, kept for older callers"),
      accountId: uuid.optional(),
      account: z.string().max(150).optional().describe("account name (exact, else partial match)"),
      categoryId: uuid.optional(),
      category: z.string().max(150).optional().describe("category name (exact, else partial match)"),
      status: transactionStatusSchema.optional(),
      type: transactionTypeSchema.optional(),
      from: isoDateSchema.optional(),
      to: isoDateSchema.optional(),
      minAmount: z.number().nonnegative().optional().describe("major units, absolute amount"),
      maxAmount: z.number().nonnegative().optional().describe("major units, absolute amount"),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("alias of pageSize"),
    }),
    async execute(ctx, args) {
      const accountId = args.accountId ?? (args.account ? (await findAccountByName(ctx.userId, args.account)).id : undefined);
      const categoryId =
        args.categoryId ?? (args.category ? (await findCategoryByName(ctx.userId, args.category)).id : undefined);
      const pageSize = args.pageSize ?? args.limit ?? 50;
      const { items, total, page } = await listTransactions(ctx.userId, {
        q: args.q ?? args.text,
        accountId,
        categoryId,
        status: args.status,
        type: args.type,
        from: args.from,
        to: args.to,
        minAmount: args.minAmount,
        maxAmount: args.maxAmount,
        page: args.page,
        pageSize,
      });
      const rows = items.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        merchant: t.merchant,
        rawDescription: t.rawDescription,
        notes: t.notes,
        category: t.category ? { id: t.category.id, name: t.category.name } : null,
        account: t.account ? { id: t.account.id, name: t.account.name, type: t.account.type } : null,
        transferAccount: t.transferAccount ? { id: t.transferAccount.id, name: t.transferAccount.name } : null,
        status: t.status,
        type: t.type,
        amountMinor: t.amountMinor,
        currency: t.currencyCode,
        tags: t.transactionTags.map(({ tag }) => tag.name),
      }));
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      return {
        forModel: {
          total,
          page,
          pageSize,
          pageCount,
          hasMore: page < pageCount,
          filters: { q: args.q ?? args.text ?? null, accountId: accountId ?? null, categoryId: categoryId ?? null, status: args.status ?? null, type: args.type ?? null, from: args.from ?? null, to: args.to ?? null, minAmount: args.minAmount ?? null, maxAmount: args.maxAmount ?? null },
          transactions: rows,
        },
        block: {
          type: "transactions",
          title: "Transactions",
          rows: rows.map((r) => ({
            id: r.id,
            date: r.date,
            description: r.description,
            amountMinor: r.amountMinor,
            currency: r.currency,
            category: r.category?.name ?? null,
          })),
          moreCount: Math.max(0, total - (page - 1) * pageSize - rows.length),
        },
      };
    },
  }),

  read({
    name: "get_transaction",
    title: "Get transaction",
    description:
      "Everything the transaction detail sheet shows for one transaction id: description, status, date and value date (the bank's settlement date when it differs), signed amount in integer minor units with currency (negative = out of the source account), type, category, splits (each with category, description and amount in minor units; the sheet shows them when there is more than one), tags, notes, account and transfer destination, raw bank description, narration, UPI reference, counterparty UPI id, UTR number, external id, extra metadata key/values, the linked bill, the suspected duplicate original (see get_review_inbox), and the source: 'Imported from <file>' when it came from a CSV import, 'Recurring: <name>' when a recurring rule drafted it, otherwise 'Manual entry'. Encrypted fields are returned decrypted. Returns error not_found for an unknown or another user's id.",
    requiredScope: "finance:read",
    input: z.object({ id: uuid }),
    async execute(ctx, args) {
      const tx = await getTransaction(ctx.userId, args.id);
      if (!tx) return { forModel: { error: "not_found" } };
      const source = tx.importFile
        ? `Imported from ${tx.importFile.fileName}`
        : tx.recurringTransaction
          ? `Recurring: ${tx.recurringTransaction.name}`
          : "Manual entry";
      return {
        forModel: {
          id: tx.id,
          date: tx.date,
          valueDate: tx.valueDate,
          description: tx.description,
          merchant: tx.merchant,
          amountMinor: tx.amountMinor,
          currency: tx.currencyCode,
          type: tx.type,
          status: tx.status,
          countsTowardBalance: ["imported", "reviewed", "posted"].includes(tx.status),
          category: tx.category ? { id: tx.category.id, name: tx.category.name } : null,
          account: tx.account ? { id: tx.account.id, name: tx.account.name, type: tx.account.type } : null,
          transferAccount: tx.transferAccount ? { id: tx.transferAccount.id, name: tx.transferAccount.name } : null,
          splits: tx.splits.map((split) => ({
            id: split.id,
            amountMinor: split.amountMinor,
            description: split.description,
            category: split.category ? { id: split.category.id, name: split.category.name } : null,
          })),
          tags: tx.transactionTags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
          notes: tx.notes,
          rawDescription: tx.rawDescription,
          narration: tx.narration,
          upiReference: tx.upiReference,
          counterpartyUpiId: tx.counterpartyUpiId,
          utrNumber: tx.utrNumber,
          externalId: tx.externalId,
          metadata: tx.metadata.map((m) => ({ key: m.key, value: m.value })),
          source,
          importFile: tx.importFile ? { id: tx.importFile.id, fileName: tx.importFile.fileName } : null,
          recurringTransaction: tx.recurringTransaction
            ? { id: tx.recurringTransaction.id, name: tx.recurringTransaction.name }
            : null,
          bill: tx.bill ? { id: tx.bill.id, name: tx.bill.name } : null,
          suspectedDuplicateOf: tx.suspectedDuplicateOf
            ? {
                id: tx.suspectedDuplicateOf.id,
                description: tx.suspectedDuplicateOf.description,
                date: tx.suspectedDuplicateOf.date,
                amountMinor: tx.suspectedDuplicateOf.amountMinor,
                status: tx.suspectedDuplicateOf.status,
              }
            : null,
          createdAt: iso(tx.createdAt),
          updatedAt: iso(tx.updatedAt),
        },
      };
    },
  }),

  read({
    name: "get_review_inbox",
    title: "Review inbox",
    description: `The Inbox page: transactions waiting for review (status pending or imported), newest first. The screen loads at most 200 items; this tool pages through those same 200 (page/pageSize up to 200), and totalAwaitingReview is the full count even beyond 200. Each item has date, description, raw description, narration, notes, signed amount in minor units with currency, status, type, account, category, UPI reference, counterparty UPI id, UTR, external id, the import file name it came from, and suspectedDuplicateOf (the existing transaction's id, description, date, amount and status) when flagged. ${DUPLICATE_NOTE} Imported items already count toward balances; pending ones do not until approved. Rejected items are in get_rejected_transactions.`,
    requiredScope: "finance:read",
    input: z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(200),
    }),
    async execute(ctx, args) {
      const [items, totalAwaitingReview] = await Promise.all([
        getInboxItems(ctx.userId),
        getInboxCount(ctx.userId),
      ]);
      const start = (args.page - 1) * args.pageSize;
      const pageItems = items.slice(start, start + args.pageSize);
      const rows = pageItems.map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        rawDescription: t.rawDescription,
        narration: t.narration,
        notes: t.notes,
        amountMinor: t.amountMinor,
        currency: t.currencyCode,
        status: t.status,
        type: t.type,
        account: t.account ? { id: t.account.id, name: t.account.name } : null,
        category: t.category ? { id: t.category.id, name: t.category.name } : null,
        upiReference: t.upiReference,
        counterpartyUpiId: t.counterpartyUpiId,
        utrNumber: t.utrNumber,
        externalId: t.externalId,
        importFileName: t.importFile?.fileName ?? null,
        suspectedDuplicateOf: t.suspectedDuplicateOf
          ? {
              id: t.suspectedDuplicateOf.id,
              description: t.suspectedDuplicateOf.description,
              date: t.suspectedDuplicateOf.date,
              amountMinor: t.suspectedDuplicateOf.amountMinor,
              status: t.suspectedDuplicateOf.status,
            }
          : null,
      }));
      return {
        forModel: {
          totalAwaitingReview,
          loaded: items.length,
          page: args.page,
          pageSize: args.pageSize,
          hasMore: start + rows.length < items.length,
          suspectedDuplicates: items.filter((t) => t.suspectedDuplicateOf).length,
          items: rows,
        },
        block: {
          type: "transactions",
          title: "Awaiting review",
          rows: rows.map((r) => ({
            id: r.id,
            date: r.date,
            description: r.description,
            amountMinor: r.amountMinor,
            currency: r.currency,
            category: r.category?.name ?? null,
          })),
          moreCount: Math.max(0, totalAwaitingReview - start - rows.length),
          href: "/inbox",
        },
      };
    },
  }),

  read({
    name: "get_rejected_transactions",
    title: "Rejected transactions",
    description:
      "The Inbox 'rejected' tab: the most recently rejected transactions (most recently changed first, default 50 like the screen, up to 200). Rejected transactions never count toward balances, reports or budgets; they can be restored. Each row has date, description, raw description, narration, notes, signed amount in minor units with currency, type, account, category, UPI reference, counterparty UPI id, UTR and external id.",
    requiredScope: "finance:read",
    input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    async execute(ctx, args) {
      const rows = await getRecentlyRejected(ctx.userId, args.limit);
      return {
        forModel: {
          count: rows.length,
          transactions: rows.map((t) => ({
            id: t.id,
            date: t.date,
            description: t.description,
            rawDescription: t.rawDescription,
            narration: t.narration,
            notes: t.notes,
            amountMinor: t.amountMinor,
            currency: t.currencyCode,
            type: t.type,
            account: t.account ? { id: t.account.id, name: t.account.name } : null,
            category: t.category ? { id: t.category.id, name: t.category.name } : null,
            upiReference: t.upiReference,
            counterpartyUpiId: t.counterpartyUpiId,
            utrNumber: t.utrNumber,
            externalId: t.externalId,
            rejectedAt: iso(t.updatedAt),
          })),
        },
      };
    },
  }),

  /* ── rules ─────────────────────────────────────────────────────────────── */

  read({
    name: "get_rule_suggestions",
    title: "Rule suggestions",
    description:
      "Rule suggestions shown on the Inbox banner and the Automations page. Method: take the 500 most recent non-rejected, non-deleted transactions; extract a merchant token from each description (lower-cased, bank prefixes and noise stripped, e.g. 'UPI-SWIGGY-...' → 'swiggy'); keep tokens seen at least 3 times; suggest the category most often used on that token's categorised transactions (null when none is categorised); keep only tokens that also appear in an uncategorised pending/imported inbox item; return the top 5 by occurrences. occurrences counts all 500 scanned transactions, not just the inbox. Nothing is created — use propose_rule / create_rule to act on one.",
    requiredScope: "rules:read",
    input: z.object({}),
    async execute(ctx) {
      const [suggestions, categories] = await Promise.all([
        getRuleSuggestions(ctx.userId),
        listCategories(ctx.userId),
      ]);
      const names = new Map(categories.map((c) => [c.id, c.name]));
      return {
        forModel: {
          suggestions: suggestions.map((s) => ({
            token: s.token,
            occurrences: s.occurrences,
            suggestedCategoryId: s.suggestedCategoryId,
            suggestedCategory: s.suggestedCategoryId ? (names.get(s.suggestedCategoryId) ?? null) : null,
          })),
        },
      };
    },
  }),

  read({
    name: "list_rules",
    title: "List rules",
    description:
      "Every automation rule, as the Automations page lists them (ordered by priority, then name). Each has name, description, active/paused, runOnImport (runs automatically after a CSV import commit), matchAll (true = every condition must match, AND; false = any, OR), priority (lower runs first), conditions and actions with their stored values and a human label (account, category, tag, bill and budget ids resolved to names; amount values are stored in integer minor units and compared against the absolute transaction amount), and the last run (matched = transactions the conditions selected, applied = transactions actually changed, error, start time).",
    requiredScope: "rules:read",
    input: z.object({}),
    async execute(ctx) {
      const [rules, settings, accounts, categories, tags, bills, budgets, archivedBudgets] = await Promise.all([
        listRules(ctx.userId),
        getUserSettings(ctx.userId),
        listAccounts(ctx.userId),
        listCategories(ctx.userId),
        listTags(ctx.userId),
        listBills(ctx.userId),
        listBudgetsWithProgress(ctx.userId),
        listArchivedBudgets(ctx.userId),
      ]);
      const accountName = new Map(accounts.map((a) => [a.id, a.name]));
      const categoryName = new Map(categories.map((c) => [c.id, c.name]));
      const tagName = new Map(tags.map((t) => [t.id, t.name]));
      const billName = new Map(bills.map((b) => [b.bill.id, b.bill.name]));
      const budgetName = new Map([...budgets, ...archivedBudgets].map((b) => [b.id, b.name]));
      const money = (value: string) => {
        const n = Number(value);
        return Number.isFinite(n) ? formatMoney(n, settings.currencyCode, { locale: settings.locale }) : `"${value}"`;
      };
      const conditionLabel = (field: string, value: string) => {
        const shown =
          field === "account_is"
            ? (accountName.get(value) ?? "a deleted account")
            : field.startsWith("amount_")
              ? money(value)
              : `"${value}"`;
        return `${CONDITION_LABEL[field] ?? field.replaceAll("_", " ")} ${shown}`;
      };
      const actionLabel = (type: string, value: string | null) => {
        switch (type) {
          case "set_category":
            return `categorise as ${value ? (categoryName.get(value) ?? "a deleted category") : "nothing"}`;
          case "add_tag":
            return `add tag ${value ? (tagName.get(value) ?? "a deleted tag") : "nothing"}`;
          case "rename_merchant":
            return `rename merchant to "${value ?? ""}"`;
          case "mark_reviewed":
            return "mark reviewed";
          case "assign_budget":
            return `assign to budget ${value ? (budgetName.get(value) ?? "a deleted budget") : "nothing"}`;
          case "link_bill":
            return `link to bill ${value ? (billName.get(value) ?? "a deleted bill") : "nothing"}`;
          default:
            return value ? `${type.replaceAll("_", " ")} "${value}"` : type.replaceAll("_", " ");
        }
      };
      const full = rules.map((r) => {
        const conditions = r.conditions.map((c) => ({ field: c.field, value: c.value, label: conditionLabel(c.field, c.value) }));
        const actions = r.actions.map((a) => ({ type: a.type, value: a.value, label: actionLabel(a.type, a.value) }));
        const run = r.runs[0];
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          isActive: r.isActive,
          runOnImport: r.runOnImport,
          matchAll: r.matchAll,
          priority: r.priority,
          conditions,
          actions,
          summary: `When ${conditions.map((c) => c.label).join(r.matchAll ? " and " : " or ")} - then ${actions.map((a) => a.label).join(", ")}`,
          lastRun: run
            ? {
                trigger: run.trigger,
                matched: run.matchedCount,
                applied: run.appliedCount,
                error: run.error,
                startedAt: iso(run.startedAt),
              }
            : null,
        };
      });
      return {
        forModel: { currency: settings.currencyCode, rules: full },
        block: {
          type: "ruleList",
          title: "Your rules",
          rules: full.map((r) => ({
            id: r.id,
            name: r.name,
            isActive: r.isActive,
            priority: r.priority,
            conditionCount: r.conditions.length,
            actionCount: r.actions.length,
            lastRun: r.lastRun ? { matched: r.lastRun.matched, applied: r.lastRun.applied, at: r.lastRun.startedAt ?? "" } : null,
          })),
        },
      };
    },
  }),

  read({
    name: "get_rule_runs",
    title: "Rule runs",
    description:
      "Recent rule executions, newest first (the Automations page shows 8; default 20, up to 200): rule name (null when the rule was deleted), trigger (manual, import or test), matched (transactions the conditions selected), applied (transactions actually changed — a match already in the target state is not re-applied), error, start and finish time.",
    requiredScope: "rules:read",
    input: z.object({ limit: z.number().int().min(1).max(200).default(20) }),
    async execute(ctx, args) {
      const runs = await listRuleRuns(ctx.userId, args.limit);
      return {
        forModel: {
          runs: runs.map((run) => ({
            id: run.id,
            ruleId: run.ruleId,
            rule: run.rule?.name ?? null,
            trigger: run.trigger,
            matched: run.matchedCount,
            applied: run.appliedCount,
            error: run.error,
            startedAt: iso(run.startedAt),
            finishedAt: iso(run.finishedAt),
          })),
        },
      };
    },
  }),

  /* ── accounts ──────────────────────────────────────────────────────────── */

  read({
    name: "get_accounts",
    title: "Accounts",
    description:
      "The Accounts page. Each account has type (asset = bank, cash, wallet, investment, credit_card, liability), institution, masked number, UPI id, current balance in integer minor units in the account's own currency (opening balance + every imported/reviewed/posted transaction on it + incoming transfers; a credit card's negative balance is what is owed), credit limit (cards) or original principal (liabilities), includeInNetWorth and isArchived. Archived accounts are left out unless includeArchived is true. netWorth is the page header: over non-archived accounts in the user's default currency with includeInNetWorth on, assets = sum of positive balances, liabilities = sum of negative balances (as a positive figure), netWorth = assets − liabilities; foreign-currency accounts are listed but excluded from it, never converted. subtotalsByType sums each type's non-archived balances as the page does.",
    requiredScope: "finance:read",
    input: z.object({ includeArchived: z.boolean().default(false) }),
    async execute(ctx, args) {
      const [all, netWorth] = await Promise.all([listAccounts(ctx.userId), getNetWorthSummary(ctx.userId)]);
      const accounts = args.includeArchived ? all : all.filter((a) => !a.isArchived);
      const rows = accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        institution: a.institution,
        accountNumberMask: a.accountNumberMask,
        upiId: a.upiId,
        balanceMinor: a.currentBalanceMinor,
        currency: a.currencyCode,
        limitMinor: a.limitMinor,
        limitKind: a.limitMinor === null ? null : a.type === "credit_card" ? "credit_limit" : "principal",
        includeInNetWorth: a.includeInNetWorth,
        isArchived: a.isArchived,
        countsInNetWorthTotal:
          !a.isArchived && a.includeInNetWorth && a.currencyCode === netWorth.currencyCode,
      }));
      const subtotals = new Map<string, { type: string; currency: string; balanceMinor: number }>();
      for (const a of all.filter((x) => !x.isArchived)) {
        const key = `${a.type}:${a.currencyCode}`;
        const entry = subtotals.get(key) ?? { type: a.type, currency: a.currencyCode, balanceMinor: 0 };
        entry.balanceMinor += a.currentBalanceMinor;
        subtotals.set(key, entry);
      }
      return {
        forModel: {
          netWorth: {
            currency: netWorth.currencyCode,
            netWorthMinor: netWorth.netWorthMinor,
            assetsMinor: netWorth.assetsMinor,
            liabilitiesMinor: netWorth.liabilitiesMinor,
          },
          subtotalsByType: [...subtotals.values()],
          accounts: rows,
        },
        block: {
          type: "accounts",
          title: "Accounts",
          rows: rows.map((r) => ({ id: r.id, name: r.name, balanceMinor: r.balanceMinor, currency: r.currency })),
        },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_account",
    title: "Account detail",
    description:
      "The account detail page for one account id: name, type, currency, institution, masked number, UPI id, notes, current balance (minor units; opening balance + its ledger transactions + incoming transfers), opening balance and its date, limit (credit limit for a card, original principal for a liability), includeInNetWorth, isArchived, and the 25 most recent transactions touching it (as source or as transfer destination, every status). For an incoming transfer effectiveAmountMinor is the amount with the sign flipped, i.e. the effect on THIS account, exactly as the page shows it; amountMinor is the stored amount from the source account's side. For a full, filterable history call search_transactions with this accountId. Returns error not_found for an unknown or another user's id.",
    requiredScope: "finance:read",
    input: z.object({ accountId: uuid }),
    async execute(ctx, args) {
      const account = await getAccount(ctx.userId, args.accountId);
      if (!account) return { forModel: { error: "not_found" } };
      const recent = await getAccountTransactions(ctx.userId, account.id, 25);
      return {
        forModel: {
          id: account.id,
          name: account.name,
          type: account.type,
          currency: account.currencyCode,
          institution: account.institution,
          accountNumberMask: account.accountNumberMask,
          upiId: account.upiId,
          notes: account.notes,
          balanceMinor: account.currentBalanceMinor,
          openingBalanceMinor: account.openingBalanceMinor,
          openingBalanceDate: account.openingBalanceDate,
          limitMinor: account.limitMinor,
          limitKind: account.limitMinor === null ? null : account.type === "credit_card" ? "credit_limit" : "principal",
          includeInNetWorth: account.includeInNetWorth,
          isArchived: account.isArchived,
          recentTransactions: recent.map((tx) => {
            const incoming = tx.type === "transfer" && tx.transferAccountId === account.id;
            return {
              id: tx.id,
              date: tx.date,
              description: tx.description,
              merchant: tx.merchant,
              type: tx.type,
              status: tx.status,
              category: tx.category?.name ?? null,
              direction: tx.type === "transfer" ? (incoming ? "incoming" : "outgoing") : null,
              counterpartAccount:
                tx.type === "transfer" ? (incoming ? (tx.account?.name ?? null) : (tx.transferAccount?.name ?? null)) : null,
              amountMinor: tx.amountMinor,
              effectiveAmountMinor: incoming ? -tx.amountMinor : tx.amountMinor,
              currency: tx.currencyCode,
            };
          }),
        },
      };
    },
  }),

  read({
    name: "get_account_balance_history",
    title: "Account balance history",
    description:
      "The balance chart on the account detail page: one stored daily snapshot per date (date, balance in minor units, currency) for one account, oldest first, over the last `months` months (default 4, like the page). Snapshots are written whenever the account's balance is recomputed (a transaction lands, a balance is recorded), so days without activity have no point — the balance carries over from the previous point. Returns error not_found for an unknown or another user's id.",
    requiredScope: "finance:read",
    input: z.object({ accountId: uuid, months: z.number().int().min(1).max(60).default(4) }),
    async execute(ctx, args) {
      const account = await getAccount(ctx.userId, args.accountId);
      if (!account) return { forModel: { error: "not_found" } };
      const history = await getAccountBalanceHistory(ctx.userId, account.id, args.months);
      return {
        forModel: {
          account: { id: account.id, name: account.name, currency: account.currencyCode },
          months: args.months,
          points: history.map((h) => ({ date: h.date, balanceMinor: h.balanceMinor, currency: h.currencyCode })),
        },
      };
    },
  }),

  /* ── reports / patterns ────────────────────────────────────────────────── */

  read({
    name: "get_cash_flow",
    title: "Cash flow",
    description: `Recorded daily cash flow over the last N days (default 30), from the day N days ago through today, one point per calendar day (days with nothing are zero). Only income and expense transactions in the user's default currency count (transfers, adjustments and opening balances are excluded; other currencies are excluded, not converted). ${LEDGER_STATUSES_NOTE} Per day: inflowMinor = sum of positive amounts, outflowMinor = sum of negative amounts as a positive figure (so an expense refund counts as inflow), netMinor = inflow − outflow. The totals add the daily points.`,
    requiredScope: "finance:read",
    input: z.object({ days: z.number().int().min(7).max(365).default(30) }),
    async execute(ctx, args) {
      const [points, settings] = await Promise.all([
        getRecentCashflow(ctx.userId, args.days),
        getUserSettings(ctx.userId),
      ]);
      const inflow = points.reduce((s, p) => s + p.inflowMinor, 0);
      const outflow = points.reduce((s, p) => s + p.outflowMinor, 0);
      return {
        forModel: {
          days: args.days,
          from: points[0]?.date ?? null,
          to: points.at(-1)?.date ?? null,
          currency: settings.currencyCode,
          inflowMinor: inflow,
          outflowMinor: outflow,
          netMinor: inflow - outflow,
          points,
        },
        block: {
          type: "cashflow",
          title: "Recorded cashflow",
          range: `Last ${args.days} days`,
          currency: settings.currencyCode,
          inflowMinor: inflow,
          outflowMinor: outflow,
          netMinor: inflow - outflow,
        },
      };
    },
  }),

  read({
    name: "get_net_worth_series",
    title: "Net worth over time",
    description:
      "The net worth chart on the Patterns page (the page uses 8 months; default 8). Built from stored daily account balance snapshots since `months` months ago, for accounts in the default currency with includeInNetWorth on — archived accounts included, since their history is real. For each date on which any account has a snapshot, every account's latest known balance up to that date is carried forward and summed (negative balances such as card debt subtract). The headline net worth in get_accounts uses current balances of non-archived accounts only, so the last point can differ from it.",
    requiredScope: "finance:read",
    input: z.object({ months: z.number().int().min(1).max(60).default(8) }),
    async execute(ctx, args) {
      const [points, settings] = await Promise.all([
        getNetWorthSeries(ctx.userId, args.months),
        getUserSettings(ctx.userId),
      ]);
      return { forModel: { currency: settings.currencyCode, months: args.months, points } };
    },
  }),

  read({
    name: "get_monthly_flows",
    title: "Monthly income and expense",
    description: `The 'Your rhythm' chart on the Patterns page (the page uses 8 months; default 8): per calendar month from the start of the month \`months − 1\` months ago through today, incomeMinor = sum of positive income transactions, expenseMinor = sum of negative expense transactions as a positive figure, netMinor = income − expense. Default currency only; transfers excluded. ${LEDGER_STATUSES_NOTE} Months with no qualifying transaction are omitted. The current month is partial.`,
    requiredScope: "finance:read",
    input: z.object({ months: z.number().int().min(1).max(60).default(8) }),
    async execute(ctx, args) {
      const [flows, settings] = await Promise.all([
        getMonthlyFlows(ctx.userId, args.months),
        getUserSettings(ctx.userId),
      ]);
      return { forModel: { currency: settings.currencyCode, months: args.months, flows } };
    },
  }),

  read({
    name: "get_patterns",
    title: "Spending patterns",
    description: `The figures on the Patterns page, as computed by the patterns view. Default currency only; ${LEDGER_STATUSES_NOTE} keptMonths/ofMonths: over the months with activity among the last 6 calendar months (current month included), how many had net (income − expense) ≥ 0 — the page reads this as 'You've kept money in X of the last Y months'. avgSavingsRatePct: the average, over those months that had income, of (income − expense) / income, ×100 and rounded (0 when no month had income). thisMonthSpendMinor / lastMonthSpendMinor: total expense this calendar month vs last (expense transactions only, refunds not netted), and spendDeltaMinor = this − last. whereItGoes (the 'Where it goes' bars): this month's spending per category, largest first. drift ('What's shifting'): per category, this month vs last month, sorted by absolute change — currentMinor, priorMinor, deltaMinor = current − prior, deltaPct = round(delta / prior × 100) (null when there was no prior spend), isNew when there was no prior spend; categories spent last month but not this month appear with current 0 and −100%. topCategory: this month's biggest category and its share of this month's spend.`,
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const [patterns, settings] = await Promise.all([
        getPatternsView(ctx.userId),
        getUserSettings(ctx.userId),
      ]);
      const rhythmRead =
        patterns.ofMonths === 0
          ? "Not enough history yet to read your rhythm."
          : patterns.keptMonths === patterns.ofMonths
            ? `You've kept money every one of the last ${patterns.ofMonths} months.`
            : `You've kept money in ${patterns.keptMonths} of the last ${patterns.ofMonths} months.`;
      const strip = ({ key, name, currentMinor, priorMinor, deltaMinor, deltaPct, isNew }: (typeof patterns.drift)[number]) => ({
        key,
        name,
        currentMinor,
        priorMinor,
        deltaMinor,
        deltaPct,
        isNew,
      });
      return {
        forModel: {
          currency: settings.currencyCode,
          month: monthLabel(todayIso()),
          rhythmRead,
          keptMonths: patterns.keptMonths,
          ofMonths: patterns.ofMonths,
          avgSavingsRatePct: patterns.avgSavingsRatePct,
          thisMonthSpendMinor: patterns.thisMonthSpendMinor,
          lastMonthSpendMinor: patterns.lastMonthSpendMinor,
          spendDeltaMinor: patterns.thisMonthSpendMinor - patterns.lastMonthSpendMinor,
          topCategory: patterns.topCategory,
          whereItGoes: patterns.drift
            .filter((d) => d.currentMinor > 0)
            .sort((a, b) => b.currentMinor - a.currentMinor)
            .map((d) => ({ name: d.name, spentMinor: d.currentMinor })),
          drift: patterns.drift.map(strip),
        },
      };
    },
  }),

  read({
    name: "get_financial_year_summary",
    title: "Financial year summary",
    description: `The financial-year panel on the Patterns page ('Earned / Spent / Saved'). The year is the current financial year from the user's settings (financialYearStartMonth, e.g. 4 = April–March). incomeMinor = sum of positive income transactions, expenseMinor = sum of negative expense transactions as a positive figure, netMinor (Saved) = income − expense, savingsRatePct = round(net / income × 100), 0 when there is no income. Default currency only; transfers excluded. ${LEDGER_STATUSES_NOTE} The year-to-date is partial until the year ends.`,
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const settings = await getUserSettings(ctx.userId);
      const fy = await getFinancialYearSummary(ctx.userId, settings.financialYearStartMonth);
      return {
        forModel: { currency: settings.currencyCode, financialYearStartMonth: settings.financialYearStartMonth, ...fy },
      };
    },
  }),

  read({
    name: "get_confidence",
    title: "Financial confidence",
    description:
      "The confidence card on the Overview: a 0–100 composite with band, a one-line read, week delta, streak, 30-day trend and the factors lifting or weighing on it. Six factors, each 0–100; a factor that does not apply is dropped and the base weights are renormalised over the rest (weight is returned). Runway (base 30%): liquid balance (positive balances of non-archived cash/wallet/bank accounts in the default currency) ÷ average monthly expense of the completed months among the last 6 (this month's expense if none); 6 months = 100. Cashflow (20%): this month's savings rate r = (income − expense)/income, score = 35 + 217·r clamped; 32 when spending with no income yet. On plan (15%): budgets with a period this month, 100 − 130 × over/total. Obligations (15%): active bills due in the next 14 days plus overdue ones, default currency: 100 if liquid balance covers their total else 55, minus 35 per overdue bill. Goals (10%): share of goals on pace (achieved counts; a dated goal is on pace when progress ≥ 90% of the elapsed share of its timeline; an undated one when it has any progress). Upkeep (10%): 100 with an empty inbox, else 100 − 4 per item clamped to 30–95. score = round(Σ score×weight). Bands: ≥80 secure, ≥62 steady, ≥42 finding footing, else stretched. A factor is lifting at ≥65 and weighing below 45. onTop = inbox empty and no bill overdue. weekDelta = today's score − the latest stored daily reading at least 7 days old (null if none); streakDays = consecutive days back from today whose stored reading was onTop. History comes from snapshots the Overview stores when opened; this tool overlays today's reading in memory and does NOT write one, so asking does not alter the history.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const view = await readConfidence(ctx.userId);
      const factor = (f: (typeof view.factors)[number]) => ({
        key: f.key,
        label: f.label,
        score: f.score,
        status: f.status,
        weight: Math.round(f.weight * 1000) / 1000,
        note: f.note,
      });
      return {
        forModel: {
          score: view.score,
          band: view.band,
          read: view.read,
          onTop: view.onTop,
          weekDelta: view.weekDelta,
          streakDays: view.streakDays,
          trend: view.trend,
          factors: view.factors.map(factor),
          lifting: view.lifting.map((f) => f.key),
          weighing: view.weighing.map((f) => f.key),
        },
      };
    },
  }),

  /* ── plan: bills, recurring, budgets, goals ────────────────────────────── */

  read({
    name: "get_bills",
    title: "Bills",
    description:
      "The Bills page: every tracked bill, active and inactive, ordered by next due date. Each has name, expected amount (integer minor units, positive) and currency, recurrence, amountStrategy (fixed: the forecast projects the typed amount; variable: it prefers the amount of the transaction that last paid the bill and falls back to the typed amount), due day, next due date, last paid date, active flag, account, category, notes, state and daysUntilDue (next due date − today; negative when late). state: inactive when paused; overdue when the next due date is before today; due_soon within 7 days; otherwise upcoming. For the forecast's view of what is still to pay see get_projected_commitments.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const bills = await listBills(ctx.userId);
      const rows = bills.map(({ bill, state, daysUntilDue }) => ({
        id: bill.id,
        name: bill.name,
        expectedAmountMinor: bill.expectedAmountMinor,
        currency: bill.currencyCode,
        recurrence: bill.recurrence,
        amountStrategy: bill.amountStrategy,
        dueDay: bill.dueDay,
        nextDueDate: bill.nextDueDate,
        lastPaidDate: bill.lastPaidDate,
        lastPaidTransactionId: bill.lastPaidTransactionId,
        isActive: bill.isActive,
        account: bill.account ? { id: bill.account.id, name: bill.account.name } : null,
        category: bill.category ? { id: bill.category.id, name: bill.category.name } : null,
        notes: bill.notes,
        state,
        daysUntilDue,
      }));
      return {
        forModel: { bills: rows },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_recurring_transactions",
    title: "Recurring",
    description:
      "The Recurring page: every recurring rule, active and paused, ordered by next run date. Each has name, type (income, expense or transfer), account, transfer destination account (transfers), category, description used for the drafted transaction, signed amount in integer minor units (negative = money out) with currency, interval, next run date, last run date and active flag. When a rule's date arrives a background job drafts a pending transaction into the inbox for review; it does not post on its own. Card installment plans shown on the same page are covered by the finance tools.",
    requiredScope: "finance:read",
    input: z.object({ includeInactive: z.boolean().default(true) }),
    async execute(ctx, args) {
      const [items, accounts] = await Promise.all([listRecurring(ctx.userId), listAccounts(ctx.userId)]);
      const accountName = new Map(accounts.map((a) => [a.id, a.name]));
      const rows = items
        .filter((r) => args.includeInactive || r.isActive)
        .map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          account: { id: r.account.id, name: r.account.name },
          transferAccount: r.transferAccountId
            ? { id: r.transferAccountId, name: accountName.get(r.transferAccountId) ?? null }
            : null,
          category: r.category ? { id: r.category.id, name: r.category.name } : null,
          description: r.description,
          amountMinor: r.amountMinor,
          currency: r.currencyCode,
          interval: r.interval,
          nextRunDate: r.nextRunDate,
          lastRunDate: r.lastRunDate,
          isActive: r.isActive,
        }));
      return {
        forModel: { recurring: rows },
        block: {
          type: "recurring",
          title: "Recurring transactions",
          rows: rows
            .filter((r) => r.isActive)
            .map((r) => ({
              id: r.id,
              name: r.name,
              amountMinor: Math.abs(r.amountMinor),
              currency: r.currency,
              interval: r.interval,
              nextDate: r.nextRunDate,
            })),
        },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_budgets",
    title: "Budget progress",
    description:
      "The Budgets page for the current month (or the month containing `month`): every non-archived budget with its categories, planned amount for the month (0 and hasPeriod false when no amount was set for that month), spent, remaining = planned − spent (negative when over), ratio = spent / planned (null when planned is 0 but there is spending), isOver (remaining < 0) and isNearLimit (not over and ratio ≥ 0.9). spent = sum of negative expense transactions (as a positive figure) dated inside the month, in the budget's categories, in the budget period's currency, in a ledger status (imported, reviewed, posted); income and refunds in those categories do not reduce it. Amounts stay in each budget's own currency. totals is the page header ('X spent of Y planned'), summed per currency. Archived budgets are in get_archived_budgets; how budgets feed the forecast is in get_budget_forecast.",
    requiredScope: "finance:read",
    input: z.object({ month: isoDateSchema.optional().describe("any date inside the month; default today") }),
    async execute(ctx, args) {
      const monthIso = args.month ?? todayIso();
      const budgets = await listBudgetsWithProgress(ctx.userId, monthIso);
      const rows = budgets.map((b) => ({
        id: b.id,
        name: b.name,
        categories: b.categories.map((c) => ({ id: c.id, name: c.name })),
        plannedMinor: b.plannedMinor,
        spentMinor: b.spentMinor,
        remainingMinor: b.remainingMinor,
        ratio: finiteOrNull(b.ratio),
        isOver: b.isOver,
        isNearLimit: b.isNearLimit,
        currency: b.currencyCode,
        hasPeriod: b.hasPeriod,
      }));
      const totals = new Map<string, { currency: string; plannedMinor: number; spentMinor: number }>();
      for (const b of budgets) {
        const entry = totals.get(b.currencyCode) ?? { currency: b.currencyCode, plannedMinor: 0, spentMinor: 0 };
        entry.plannedMinor += b.plannedMinor;
        entry.spentMinor += b.spentMinor;
        totals.set(b.currencyCode, entry);
      }
      return {
        forModel: {
          period: monthLabel(monthIso),
          periodStart: budgets[0]?.periodStart ?? null,
          periodEnd: budgets[0]?.periodEnd ?? null,
          totals: [...totals.values()],
          budgets: rows,
          missingPeriods: budgets.filter((b) => !b.hasPeriod).length,
        },
        block: {
          type: "budgets",
          title: "Budget status",
          period: monthLabel(monthIso),
          rows: budgets.map((b) => ({
            id: b.id,
            name: b.name,
            plannedMinor: b.plannedMinor,
            spentMinor: b.spentMinor,
            remainingMinor: b.remainingMinor,
            ratio: b.ratio,
            isOver: b.isOver,
            currency: b.currencyCode,
          })),
        },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  read({
    name: "get_archived_budgets",
    title: "Archived budgets",
    description:
      "Budgets that were archived (the 'Archived' list under the Budgets page), by name. They are excluded from budget progress, the forecast and confidence until restored.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const archived = await listArchivedBudgets(ctx.userId);
      return {
        forModel: {
          budgets: archived.map((b) => ({ id: b.id, name: b.name, archivedSince: iso(b.updatedAt) })),
        },
      };
    },
  }),

  read({
    name: "get_goals",
    title: "Goals",
    description:
      "The Goals page: every savings goal with target and current amount (integer minor units, the goal's own currency), linked account name (null = 'Manual', tracked by hand), target date, achievedAt and createdAt. Derived exactly as the page shows them: ratio = current / target (1 when the target is 0 and there is money, else 0); percent = round(min(1, ratio) × 100); remainingMinor = max(0, target − current); achieved = achievedAt set or ratio ≥ 1; daysUntilTarget = target date − today (negative when past); pace = elapsed share of the timeline from creation to target date (null when undated) — 'where you should be by now'; behindPace = not achieved and ratio < 90% of pace.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const goals = await listGoals(ctx.userId);
      const today = todayIso();
      const rows = goals.map((g) => {
        const ratio =
          g.targetAmountMinor > 0 ? g.currentAmountMinor / g.targetAmountMinor : g.currentAmountMinor > 0 ? 1 : 0;
        const achieved = !!g.achievedAt || ratio >= 1;
        const daysUntilTarget = g.targetDate ? daysBetweenIso(today, g.targetDate) : null;
        let pace: number | null = null;
        if (g.targetDate) {
          const total = daysBetweenIso(g.createdAt.toISOString().slice(0, 10), g.targetDate);
          pace = total > 0 ? Math.min(1, Math.max(0, (total - (daysUntilTarget ?? 0)) / total)) : 1;
        }
        return {
          id: g.id,
          name: g.name,
          currentMinor: g.currentAmountMinor,
          targetMinor: g.targetAmountMinor,
          remainingMinor: Math.max(0, g.targetAmountMinor - g.currentAmountMinor),
          ratio,
          percent: Math.round(Math.min(1, ratio) * 100),
          currency: g.currencyCode,
          account: g.account ? { id: g.account.id, name: g.account.name } : null,
          targetDate: g.targetDate,
          daysUntilTarget,
          achieved,
          achievedAt: g.achievedAt,
          createdAt: iso(g.createdAt),
          pace: pace === null ? null : Math.round(pace * 1000) / 1000,
          behindPace: !achieved && pace !== null && ratio < pace * 0.9,
        };
      });
      return {
        forModel: { goals: rows },
        block: {
          type: "goals",
          title: "Savings goals",
          rows: rows.map((r) => ({
            id: r.id,
            name: r.name,
            currentMinor: r.currentMinor,
            targetMinor: r.targetMinor,
            ratio: Math.min(1, r.ratio),
            currency: r.currency,
            targetDate: r.targetDate,
          })),
        },
        blocks: currencyWarningBlocks(ctx.currency, rows.map((row) => row.currency)),
      };
    },
  }),

  /* ── imports ───────────────────────────────────────────────────────────── */

  read({
    name: "get_import_files",
    title: "Import history",
    description:
      "The 'Recent imports' list on the Import page: the 30 most recent CSV uploads, newest first, with file name, target account, status (uploaded → mapped → previewed → committed, or failed), row count, error message, the column mapping and date format used, upload time and commit time. Row-level detail is in get_import_file.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const files = await listImportFiles(ctx.userId);
      return {
        forModel: {
          files: files.map((f) => ({
            id: f.id,
            fileName: f.fileName,
            account: f.account ? { id: f.account.id, name: f.account.name } : null,
            status: f.status,
            rowCount: f.rowCount,
            errorMessage: f.errorMessage,
            columns: f.columns,
            mapping: f.mapping,
            dateFormat: f.dateFormat,
            createdAt: iso(f.createdAt),
            committedAt: iso(f.committedAt),
          })),
        },
      };
    },
  }),

  read({
    name: "get_import_mappings",
    title: "Import templates",
    description:
      "Saved CSV column mappings (the templates offered by the Import wizard), most recently updated first: name, mapping of CSV columns to fields, and date format.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const mappings = await listImportMappings(ctx.userId);
      return {
        forModel: {
          mappings: mappings.map((m) => ({
            id: m.id,
            name: m.name,
            mapping: m.mapping,
            dateFormat: m.dateFormat,
            updatedAt: iso(m.updatedAt),
          })),
        },
      };
    },
  }),

  read({
    name: "get_import_file",
    title: "Import preview",
    description: `One CSV import with its row-level preview, as the Import wizard shows it: file name, account, status, columns, mapping, date format, error, and the rows in file order (paged; page/pageSize up to 200). Each row has its index, raw CSV values, status (pending = ready to import, approved, rejected, duplicate = excluded by default, error), parsed date, parsed amount in integer minor units (in the account's currency), parsed description, parsed external id, parse error, the transaction it created (after commit) and, for duplicates, the existing transaction it matched (id, description, date, amount). ${DUPLICATE_NOTE} counts tallies every row of the file by status. Returns error not_found for an unknown or another user's id.`,
    requiredScope: "finance:read",
    input: z.object({
      id: uuid,
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(200).default(100),
    }),
    async execute(ctx, args) {
      const file = await getImportFile(ctx.userId, args.id);
      if (!file) return { forModel: { error: "not_found" } };
      const counts: Record<string, number> = {};
      for (const row of file.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
      const start = (args.page - 1) * args.pageSize;
      const rows = file.rows.slice(start, start + args.pageSize);
      return {
        forModel: {
          id: file.id,
          fileName: file.fileName,
          account: file.account,
          currency: file.account?.currencyCode ?? null,
          status: file.status,
          rowCount: file.rowCount,
          columns: file.columns,
          mapping: file.mapping,
          dateFormat: file.dateFormat,
          errorMessage: file.errorMessage,
          createdAt: iso(file.createdAt),
          committedAt: iso(file.committedAt),
          counts,
          totalRows: file.rows.length,
          page: args.page,
          pageSize: args.pageSize,
          hasMore: start + rows.length < file.rows.length,
          rows: rows.map((row) => ({
            id: row.id,
            rowIndex: row.rowIndex,
            raw: row.raw,
            status: row.status,
            parsedDate: row.parsedDate,
            parsedAmountMinor: row.parsedAmountMinor,
            parsedDescription: row.parsedDescription,
            parsedExternalId: row.parsedExternalId,
            parseError: row.parseError,
            transactionId: row.transactionId,
            duplicateOf: row.duplicateOfTransaction
              ? {
                  id: row.duplicateOfTransaction.id,
                  description: row.duplicateOfTransaction.description,
                  date: row.duplicateOfTransaction.date,
                  amountMinor: row.duplicateOfTransaction.amountMinor,
                }
              : null,
          })),
        },
      };
    },
  }),

  /* ── settings / system ─────────────────────────────────────────────────── */

  read({
    name: "get_settings",
    title: "Settings",
    description:
      "The user's regional settings from the Settings page: country, default currency (every report, net worth, patterns and confidence figure uses only this currency; other currencies are excluded, not converted), locale (number and date formatting), date format, and financial year start month (1–12; drives get_financial_year_summary). Defaults (IN, INR, en-IN, dd MMM yyyy, April) apply until the user saves settings.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute(ctx) {
      const settings = await getUserSettings(ctx.userId);
      return { forModel: settings };
    },
  }),

  read({
    name: "get_system_health",
    title: "System health",
    description:
      "The System health page (instance-wide, not per user): app version and environment, each self-hosting check (database connection and Postgres version, migrations applied, app URL, file storage writable, background jobs, auth secret, telemetry) with status ok/warn/error and detail, passing count, and every background job with schedule, last run, last status, last error and duration. Jobs read 'stale' when their last run is over 36 hours old.",
    requiredScope: "finance:read",
    input: z.object({}),
    async execute() {
      const health = await getSystemHealth();
      const issues = health.checks.filter((c) => c.status !== "ok").length;
      return {
        forModel: {
          version: health.version,
          environment: health.environment,
          checksPassing: health.checks.length - issues,
          checksTotal: health.checks.length,
          checks: health.checks,
          jobs: health.jobs.map((job) => ({
            name: job.name,
            description: job.description,
            schedule: job.schedule,
            lastRunAt: iso(job.lastRunAt),
            lastStatus: job.lastStatus,
            lastError: job.lastError,
            lastDurationMs: job.lastDurationMs,
          })),
        },
      };
    },
  }),

  /* ── open finance ──────────────────────────────────────────────────────── */

  read({
    name: "get_open_finance_status",
    title: "Open Finance status",
    description:
      "The Open Finance settings page. enabled says whether Pluggy is configured on this instance (PLUGGY_ENABLED plus client id and secret); when false no sync runs. connections: each bank connection with institution, label, provider status and execution status, active flag, dataAgeDays (whole days since the provider last reached the institution — the freshness the user experiences, not our last attempt), consentExpiresAt / consentExpired, lastSyncedAt, last sync status and error, the last run's counts, and its account links. Each link has its id, provider account id, provider type and subtype, provider name, masked number, currency, linkedAccount (Kosh account id and name; null = not linked), linked credit card id, linkMode and linkConfidence (how the link was decided), the decision note, syncedThrough, sync enabled, and the provider's balance (minor units) with when it was observed. syncRuns: the 20 most recent sync runs across connections (trigger, status, start/completion, institution, records seen/created/updated, duplicates, needsReview, skipped, error). linkTargets: the non-archived accounts a link can be pointed at.",
    requiredScope: "finance:read",
    input: z.object({ syncRunLimit: z.number().int().min(1).max(200).default(20) }),
    async execute(ctx, args) {
      const [connections, runs, targets] = await Promise.all([
        listConnections(ctx.userId),
        listSyncRuns(ctx.userId, args.syncRunLimit),
        listLinkTargets(ctx.userId),
      ]);
      const runCounts = (run: (typeof runs)[number]) => ({
        id: run.id,
        connectionId: run.connectionId,
        trigger: run.trigger,
        status: run.status,
        institution: run.institution,
        startedAt: iso(run.startedAt),
        completedAt: iso(run.completedAt),
        seen: run.recordsSeen,
        created: run.recordsCreated,
        updated: run.recordsUpdated,
        duplicates: run.duplicates,
        needsReview: run.needsReview,
        skipped: run.skipped,
        error: run.error,
      });
      return {
        forModel: {
          enabled: isOpenFinanceEnabled(),
          connections: connections.map((connection) => ({
            id: connection.id,
            provider: connection.provider,
            institution: connection.connectorName,
            label: connection.label,
            status: connection.status,
            executionStatus: connection.executionStatus,
            isActive: connection.isActive,
            dataAgeDays: connection.dataAgeDays,
            providerLastUpdatedAt: iso(connection.providerLastUpdatedAt),
            consentExpiresAt: iso(connection.consentExpiresAt),
            consentExpired: connection.consentExpired,
            lastSyncedAt: iso(connection.lastSyncedAt),
            lastSyncStatus: connection.lastSyncStatus,
            lastSyncError: connection.lastSyncError,
            lastRun: connection.lastRun ? runCounts(connection.lastRun) : null,
            accounts: connection.links.map((link) => ({
              linkId: link.id,
              providerAccountId: link.providerAccountId,
              providerType: link.providerType,
              providerSubtype: link.providerSubtype,
              providerName: link.providerName,
              providerNumberMask: link.providerNumberMask,
              currency: link.currencyCode,
              linkedAccount: link.accountId ? { id: link.accountId, name: link.accountName } : null,
              creditCardId: link.creditCardId,
              linkMode: link.linkMode,
              linkConfidence: link.linkConfidence,
              decision: link.linkDecisionNote,
              syncedThrough: link.syncedThrough,
              isSyncEnabled: link.isSyncEnabled,
              providerBalanceMinor: link.providerBalanceMinor,
              providerBalanceObservedAt: iso(link.providerBalanceObservedAt),
            })),
          })),
          syncRuns: runs.map(runCounts),
          linkTargets: targets.map((t) => ({ id: t.id, name: t.name, type: t.type, currency: t.currencyCode })),
        },
      };
    },
  }),
];
