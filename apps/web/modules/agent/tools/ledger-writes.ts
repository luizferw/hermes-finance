import "server-only";
import { z } from "zod";
import { computeImportHash, formatMoney, majorToMinor, todayIso } from "@kosh/domain";
import { listAccounts } from "@/modules/accounts/queries";
import { createAccountCore, updateAccountCore } from "@/modules/accounts/mutations";
import { accountTypeSchema } from "@/modules/accounts/validators";
import { getTransaction } from "@/modules/transactions/queries";
import {
  bulkCategorizeCore,
  createTransactionCore,
  deleteTransactionCore,
  rejectTransactionsCore,
  restoreTransactionsCore,
  updateTransactionCore,
} from "@/modules/transactions/mutations";
import type { UpdateTransactionInput } from "@/modules/transactions/validators";
import { listCategories, listTags } from "@/modules/taxonomy/queries";
import { createCategoryCore, createTagCore } from "@/modules/taxonomy/mutations";
import {
  createRuleCore,
  deleteRuleCore,
  listRulesCore,
  updateRuleCore,
} from "@/modules/rules/core";
import { previewRuleDefinition } from "@/modules/rules/engine";
import type { CreateRuleInput } from "@/modules/rules/validators";
import { getImportFile, listImportMappings } from "@/modules/imports/queries";
import {
  applyImportMappingCore,
  commitImportCore,
  deleteImportCore,
  includeDuplicateRowsCore,
  uploadImportCore,
} from "@/modules/imports/mutations";
import { importFieldSchema, type ApplyMappingInput } from "@/modules/imports/validators";
import { getUserSettings } from "@/modules/settings/queries";
import { updateUserSettingsCore } from "@/modules/settings/mutations";
import { listConnections } from "@/modules/open-finance/queries";
import {
  registerConnectionCore,
  removeConnectionCore,
  updateAccountLinkCore,
} from "@/modules/open-finance/mutations";
import { syncConnection } from "@/modules/open-finance/sync";
import type { ExecStatus, ResponseBlock, ToolContext, WriteTool } from "../types";
import {
  currencyCodeInput,
  formatMajor,
  isoDateSchema,
  resolveAccount,
  resolveCategory,
  resolveNamedAccount,
  write,
} from "./shared";

/* ── helpers ────────────────────────────────────────────────────────────── */

type Outcome = Awaited<ReturnType<WriteTool["execute"]>>;

/**
 * A completed outcome that also carries structured `data`. The MCP endpoint
 * serialises the whole outcome, so `data` is how an external caller receives
 * ids and engine results without parsing prose. Built as a variable (not a
 * returned literal) because `Outcome` has no `data` field to declare it on.
 */
function completed(title: string, detail?: string, data?: unknown, status: ExecStatus = "completed"): Outcome {
  const outcome = {
    status,
    title,
    detail,
    block: { type: "result", status, title, detail } as ResponseBlock,
    data,
  };
  return outcome;
}

function txLabel(tx: { description: string; amountMinor: number; currencyCode: string; date: string }) {
  return `${tx.date} · ${tx.description} · ${formatMoney(tx.amountMinor, tx.currencyCode)}`;
}

/** Category by name, or an error — never a silent "uncategorised". */
async function requireCategory(userId: string, name: string) {
  const category = await resolveCategory(userId, name);
  if (!category) throw new Error(`No category matching "${name}". Create it with create_category first.`);
  return category;
}

/** Tags by exact (case-insensitive) name. Unknown names fail loudly. */
async function resolveTags(userId: string, names: string[]) {
  if (names.length === 0) return [];
  const tags = await listTags(userId);
  return names.map((name) => {
    const tag = tags.find((t) => t.name.toLowerCase() === name.trim().replace(/^#/, "").toLowerCase());
    if (!tag) throw new Error(`No tag named "${name}". Create it with create_tag first.`);
    return tag;
  });
}

/** Account by name including archived ones (needed to un-archive). No fallback. */
async function resolveAnyAccount(userId: string, name: string) {
  const accounts = await listAccounts(userId);
  const h = name.toLowerCase();
  const account =
    accounts.find((a) => a.name.toLowerCase() === h) ??
    accounts.find((a) => a.name.toLowerCase().includes(h));
  if (!account) throw new Error(`No account matching "${name}".`);
  return account;
}

async function previewTransactions(userId: string, ids: string[]) {
  const rows = await Promise.all(ids.slice(0, 6).map((id) => getTransaction(userId, id)));
  return rows.filter((row): row is NonNullable<typeof row> => !!row);
}

const idsInput = z.array(z.string().uuid()).min(1).max(500);

/* ── rules (same vocabulary as the automations screen) ──────────────────── */

const ruleConditionInput = z.object({
  field: z.enum([
    "description_contains",
    "raw_text_contains",
    "amount_greater_than",
    "amount_less_than",
    "amount_equals",
    "account_is",
    "transaction_type_is",
  ]),
  value: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "text to match; for account_is the account name; for transaction_type_is income|expense|transfer; for amount_* an amount in major units (e.g. 49.90)",
    ),
});

const ruleActionInput = z.object({
  type: z.enum(["set_category", "add_tag", "rename_merchant", "mark_reviewed"]),
  value: z
    .string()
    .max(300)
    .nullish()
    .describe("category name for set_category; tag name for add_tag; new merchant name for rename_merchant; omit for mark_reviewed"),
});

const ruleDefinitionInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().describe("free-text note shown on the rule card"),
  matchAll: z.boolean().default(true).describe("true = every condition must match (AND); false = any condition (OR)"),
  runOnImport: z
    .boolean()
    .default(true)
    .describe("true = the rule also runs automatically on every future CSV import and Open Finance sync"),
  conditions: z.array(ruleConditionInput).min(1).max(10),
  actions: z.array(ruleActionInput).min(1).max(10),
});
type RuleDefinitionInput = z.infer<typeof ruleDefinitionInput>;

const CONDITION_LABEL: Record<string, string> = {
  description_contains: "description contains",
  raw_text_contains: "raw text contains",
  amount_greater_than: "amount greater than",
  amount_less_than: "amount less than",
  amount_equals: "amount equals",
  account_is: "account is",
  transaction_type_is: "type is",
};

interface ResolvedRule {
  definition: CreateRuleInput;
  when: string;
  then: string;
}

async function resolveRuleDefinition(ctx: ToolContext, input: RuleDefinitionInput): Promise<ResolvedRule> {
  const conditions: CreateRuleInput["conditions"] = [];
  const conditionLabels: string[] = [];
  for (const c of input.conditions) {
    let value = c.value.trim();
    let display = value;
    if (c.field === "account_is") {
      const account = await resolveNamedAccount(ctx.userId, value);
      value = account.id;
      display = account.name;
    } else if (c.field === "transaction_type_is") {
      if (!["income", "expense", "transfer"].includes(value)) {
        throw new Error(`transaction_type_is takes income, expense or transfer, not "${value}".`);
      }
    } else if (c.field.startsWith("amount_")) {
      const major = Number(value);
      if (!Number.isFinite(major)) throw new Error(`"${c.value}" is not an amount.`);
      // Same conversion as the rule builder: the user's display currency.
      const minor = majorToMinor(major, ctx.currency);
      value = String(minor);
      display = formatMoney(minor, ctx.currency);
    }
    conditions.push({ field: c.field, value });
    conditionLabels.push(`${CONDITION_LABEL[c.field]} ${display}`);
  }

  const actions: CreateRuleInput["actions"] = [];
  const actionLabels: string[] = [];
  for (const a of input.actions) {
    if (a.type === "set_category") {
      if (!a.value) throw new Error("set_category needs a category name.");
      const category = await requireCategory(ctx.userId, a.value);
      actions.push({ type: "set_category", value: category.id });
      actionLabels.push(`categorise as ${category.name}`);
    } else if (a.type === "add_tag") {
      if (!a.value) throw new Error("add_tag needs a tag name.");
      const [tag] = await resolveTags(ctx.userId, [a.value]);
      actions.push({ type: "add_tag", value: tag!.id });
      actionLabels.push(`add tag #${tag!.name}`);
    } else if (a.type === "rename_merchant") {
      if (!a.value) throw new Error("rename_merchant needs a new merchant name.");
      actions.push({ type: "rename_merchant", value: a.value });
      actionLabels.push(`rename merchant to ${a.value}`);
    } else {
      actions.push({ type: "mark_reviewed", value: null });
      actionLabels.push("mark reviewed");
    }
  }

  return {
    definition: {
      name: input.name,
      description: input.description,
      matchAll: input.matchAll,
      runOnImport: input.runOnImport,
      conditions,
      actions,
    },
    when: conditionLabels.join(input.matchAll ? " AND " : " OR "),
    then: actionLabels.join(", "),
  };
}

async function rulePreview(ctx: ToolContext, definition: CreateRuleInput) {
  return previewRuleDefinition(ctx.userId, {
    matchAll: definition.matchAll,
    conditions: definition.conditions,
    actions: definition.actions.map((a) => ({ type: a.type, value: a.value ?? null })),
  });
}

const RULE_SEMANTICS =
  "Conditions: description_contains / raw_text_contains are case-insensitive substring matches (raw text is the bank's encrypted narration, so it cannot be pre-filtered in SQL and forces a full scan); amount_* compare the ABSOLUTE transaction amount against the value converted to minor units with the user's display currency; account_is takes an account name (no fuzzy fallback: an unknown name fails); transaction_type_is is income|expense|transfer. Actions: set_category (category name), add_tag (tag name), rename_merchant (new name), mark_reviewed (moves imported/pending rows to reviewed). Amount values are major units. Saving a rule does not change existing transactions: use run_rule for that. runOnImport=true (default) applies the rule automatically to every future CSV import commit and Open Finance sync.";

/* ── import wizard ─────────────────────────────────────────────────────── */

/** Characters accepted in one upload over MCP. The wizard's own limit is 5 MB. */
const MAX_IMPORT_CHARS = 2_000_000;
const IMPORT_DATE_FORMATS = ["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "dd-MM-yyyy", "dd/MM/yy", "dd MMM yyyy"] as const;

async function requireImport(userId: string, importFileId: string) {
  const file = await getImportFile(userId, importFileId);
  if (!file) throw new Error("Import not found.");
  return file;
}

/** The preview the wizard renders at step 3, from the same query it fetches. */
async function importPreview(userId: string, importFileId: string, page: number, pageSize: number) {
  const file = await requireImport(userId, importFileId);
  const currency = file.account?.currencyCode ?? "INR";
  const rows = file.rows;
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const start = (page - 1) * pageSize;
  return {
    importFileId: file.id,
    fileName: file.fileName,
    status: file.status,
    account: file.account ? { id: file.account.id, name: file.account.name } : null,
    currency,
    mapping: file.mapping,
    dateFormat: file.dateFormat,
    counts: {
      total: rows.length,
      ready: count("pending"),
      duplicates: count("duplicate"),
      errors: count("error"),
      approved: count("approved"),
      rejected: count("rejected"),
    },
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
    rows: rows.slice(start, start + pageSize).map((r) => ({
      id: r.id,
      rowNumber: r.rowIndex + 1,
      status: r.status,
      date: r.parsedDate,
      amountMinor: r.parsedAmountMinor,
      currency,
      description: r.parsedDescription,
      externalId: r.parsedExternalId,
      parseError: r.parseError,
      duplicateOf: r.duplicateOfTransaction
        ? {
            id: r.duplicateOfTransaction.id,
            description: r.duplicateOfTransaction.description,
            date: r.duplicateOfTransaction.date,
            amountMinor: r.duplicateOfTransaction.amountMinor,
          }
        : r.status === "duplicate"
          ? { id: null, description: "an identical row earlier in this same file", date: r.parsedDate, amountMinor: r.parsedAmountMinor }
          : null,
    })),
  };
}

/* ── settings (the options the settings screen offers) ──────────────────── */

const SETTINGS_CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "BRL"] as const;
const SETTINGS_LOCALES = ["en-IN", "en-US", "en-GB", "pt-BR"] as const;
const SETTINGS_DATE_FORMATS = ["dd MMM yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy"] as const;

/* ── open finance ──────────────────────────────────────────────────────── */

async function requireConnection(userId: string, connectionId: string) {
  const connection = (await listConnections(userId)).find((c) => c.id === connectionId);
  if (!connection) throw new Error("Open Finance connection not found.");
  return connection;
}

function connectionName(connection: { label: string | null; id: string }) {
  return connection.label ?? `connection ${connection.id.slice(0, 8)}`;
}

/* ── tools ─────────────────────────────────────────────────────────────── */

export const ledgerWritesTools: WriteTool[] = [
  /* ── transactions ── */
  write({
    name: "create_transaction",
    title: "Add transaction",
    description:
      "Record an expense, income or transfer, exactly like the New transaction dialog. `amount` is a positive number in MAJOR units of the account's currency (e.g. 49.90); the sign is derived from `type`: expense and transfer are stored negative on `account`, income positive, converted to integer minor units with the account currency's exponent. `account` is an account name (defaults to the first non-archived account when omitted; an unknown name falls back the same way, so pass it when it matters). type=transfer moves money between two of your own accounts: `toAccount` is required, both accounts must share a currency, the source is debited and the destination credited by the same amount (nets to zero, PRD R5), and it takes no category (a transfer is neither income nor expense). `category` and `tags` are names (tags must already exist; unknown names fail). status=posted (default) counts in account balances, reports and the forecast immediately; status=pending parks the entry in the Inbox and keeps it out of balances until approved with mark_transaction_reviewed. `date` defaults to today. Returns the new transaction id and stored amountMinor.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      description: z.string().min(1).max(300),
      amount: z.number().positive().describe("major units, always positive"),
      type: z.enum(["income", "expense", "transfer"]).default("expense"),
      account: z.string().optional().describe("account name (the source account for a transfer)"),
      toAccount: z.string().optional().describe("destination account name; required for type=transfer"),
      category: z.string().optional().describe("category name; not allowed for transfers"),
      tags: z.array(z.string()).max(20).optional().describe("existing tag names"),
      notes: z.string().max(2000).optional(),
      merchant: z.string().max(150).optional(),
      date: isoDateSchema.optional(),
      status: z.enum(["posted", "pending"]).default("posted"),
    }),
    async prepare(ctx, args) {
      const account = await resolveAccount(ctx.userId, args.account);
      if (!account) throw new Error("No account found to add this to.");
      let toAccount: Awaited<ReturnType<typeof resolveNamedAccount>> | null = null;
      if (args.type === "transfer") {
        if (!args.toAccount) throw new Error("A transfer needs `toAccount`, the destination account.");
        if (args.category) throw new Error("A transfer between your own accounts takes no category (PRD R5).");
        toAccount = await resolveNamedAccount(ctx.userId, args.toAccount);
        if (toAccount.id === account.id) throw new Error("Source and destination must differ.");
        if (toAccount.currencyCode !== account.currencyCode) {
          throw new Error("Transfers between accounts in different currencies are not supported.");
        }
      } else if (args.toAccount) {
        throw new Error("`toAccount` only applies to type=transfer.");
      }
      const category = args.category ? await requireCategory(ctx.userId, args.category) : null;
      const tags = await resolveTags(ctx.userId, args.tags ?? []);
      const date = args.date ?? todayIso();
      const payload = {
        accountId: account.id,
        transferAccountId: toAccount?.id,
        type: args.type,
        amount: args.amount,
        description: args.description,
        merchant: args.merchant,
        categoryId: category?.id ?? null,
        notes: args.notes,
        tagIds: tags.map((t) => t.id),
        status: args.status,
        date,
      };
      return {
        payload,
        title: "Add transaction?",
        summary: args.description,
        fields: [
          { label: "Amount", value: `${formatMajor(args.amount, account.currencyCode)} ${args.type}` },
          { label: args.type === "transfer" ? "From" : "Account", value: account.name },
          ...(toAccount ? [{ label: "To", value: toAccount.name }] : []),
          ...(args.type !== "transfer" ? [{ label: "Category", value: category?.name ?? "Uncategorised" }] : []),
          ...(tags.length ? [{ label: "Tags", value: tags.map((t) => `#${t.name}`).join(" ") }] : []),
          { label: "Date", value: date },
          { label: "Status", value: args.status === "pending" ? "Pending (Inbox, not in balances yet)" : "Posted (counts now)" },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const tx = await createTransactionCore(ctx.userId, payload as never);
      return completed("Transaction added", `${tx.description} · ${formatMoney(tx.amountMinor, tx.currencyCode)}`, {
        id: tx.id,
        type: tx.type,
        status: tx.status,
        date: tx.date,
        amountMinor: tx.amountMinor,
        currency: tx.currencyCode,
        accountId: tx.accountId,
        transferAccountId: tx.transferAccountId,
      });
    },
  }),

  write({
    name: "update_transaction",
    title: "Edit transaction",
    description:
      "Edit one transaction by id. Only the fields you pass change. Editable: date, description, merchant (null clears), category (name; null clears; also mirrored onto the single split), notes (null clears), tags (names; REPLACES the whole tag set, [] removes all), status. Amount, account and type are not editable here or on screen (they determine balances and duplicate detection): delete_transaction and create_transaction instead. Status semantics: imported, reviewed and posted rows count in account balances; pending and rejected rows do not. Changing status recomputes the affected account balances (both legs for a transfer), which the position and forecast start from.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      id: z.string().uuid(),
      date: isoDateSchema.optional(),
      description: z.string().min(1).max(300).optional(),
      merchant: z.string().max(150).nullish(),
      category: z.string().nullish().describe("category name, or null to clear"),
      notes: z.string().max(2000).nullish(),
      tags: z.array(z.string()).max(20).optional().describe("replaces all tags"),
      status: z.enum(["pending", "imported", "reviewed", "posted", "rejected"]).optional(),
    }),
    async prepare(ctx, args) {
      const tx = await getTransaction(ctx.userId, args.id);
      if (!tx) throw new Error("Transaction not found.");
      const changes: UpdateTransactionInput = {};
      const fields: Array<{ label: string; value: string }> = [{ label: "Transaction", value: txLabel(tx) }];
      if (args.date !== undefined) {
        changes.date = args.date;
        fields.push({ label: "Date", value: `${tx.date} → ${args.date}` });
      }
      if (args.description !== undefined) {
        changes.description = args.description;
        fields.push({ label: "Description", value: `${tx.description} → ${args.description}` });
      }
      if (args.merchant !== undefined) {
        changes.merchant = args.merchant;
        fields.push({ label: "Merchant", value: `${tx.merchant ?? "—"} → ${args.merchant ?? "—"}` });
      }
      if (args.category !== undefined) {
        const category = args.category === null ? null : await requireCategory(ctx.userId, args.category);
        if (category && tx.type === "transfer") {
          throw new Error("A transfer between your own accounts takes no category (PRD R5).");
        }
        changes.categoryId = category?.id ?? null;
        fields.push({ label: "Category", value: `${tx.category?.name ?? "Uncategorised"} → ${category?.name ?? "Uncategorised"}` });
      }
      if (args.notes !== undefined) {
        changes.notes = args.notes;
        fields.push({ label: "Notes", value: args.notes ?? "(cleared)" });
      }
      if (args.tags !== undefined) {
        const tags = await resolveTags(ctx.userId, args.tags);
        changes.tagIds = tags.map((t) => t.id);
        fields.push({
          label: "Tags",
          value: `${tx.transactionTags.map((t) => `#${t.tag.name}`).join(" ") || "none"} → ${tags.map((t) => `#${t.name}`).join(" ") || "none"}`,
        });
      }
      if (args.status !== undefined) {
        changes.status = args.status;
        fields.push({ label: "Status", value: `${tx.status} → ${args.status}` });
      }
      if (Object.keys(changes).length === 0) throw new Error("Nothing to change: pass at least one field.");
      return {
        payload: { id: args.id, changes },
        title: "Edit transaction?",
        summary: tx.description,
        fields,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; changes: UpdateTransactionInput };
      await updateTransactionCore(ctx.userId, p.id, p.changes);
      const tx = await getTransaction(ctx.userId, p.id);
      return completed("Transaction updated", tx ? txLabel(tx) : undefined, {
        id: p.id,
        changed: Object.keys(p.changes),
        status: tx?.status,
        category: tx?.category?.name ?? null,
        tags: tx?.transactionTags.map((t) => t.tag.name) ?? [],
      });
    },
  }),

  write({
    name: "delete_transaction",
    title: "Delete transaction",
    description:
      "Delete one transaction by id (soft delete: the row is hidden from every list, report, balance and the forecast; it stays in the database for audit but cannot be restored from the UI). The balances of the account, and of the destination account for a transfer, are recomputed without it.",
    risk: "sensitive",
    requiredScope: "transactions:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const tx = await getTransaction(ctx.userId, args.id);
      if (!tx) throw new Error("Transaction not found.");
      return {
        payload: { id: args.id },
        title: "Delete this transaction?",
        summary: txLabel(tx),
        fields: [
          { label: "Transaction", value: txLabel(tx) },
          { label: "Account", value: tx.transferAccount ? `${tx.account.name} → ${tx.transferAccount.name}` : tx.account.name },
          { label: "Status", value: tx.status },
        ],
        warning: "It can't be undone from the UI.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      const tx = await deleteTransactionCore(ctx.userId, p.id);
      return completed("Transaction deleted", tx.description, { id: p.id });
    },
  }),

  /* ── inbox ── */
  write({
    name: "reject_transactions",
    title: "Reject transactions",
    description:
      "Reject transactions by id, as the Inbox's Reject button does: status becomes `rejected`, which removes them from account balances, reports and the forecast, but keeps them (and their import provenance) in the Inbox's Rejected tab so they can be restored with restore_transactions. Ids you don't own are ignored. Returns how many were rejected.",
    risk: "write",
    requiredScope: "reviews:write",
    input: z.object({ ids: idsInput }),
    async prepare(ctx, args) {
      const sample = await previewTransactions(ctx.userId, args.ids);
      return {
        payload: { ids: args.ids },
        title: "Reject these?",
        summary: `${args.ids.length} transaction(s) will be excluded from your ledger.`,
        fields: sample.map((t) => ({ label: t.status, value: txLabel(t) })),
        affectedCount: args.ids.length,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const r = await rejectTransactionsCore(ctx.userId, payload as { ids: string[] });
      return completed(`Rejected ${r.rejected}`, undefined, r);
    },
  }),

  write({
    name: "restore_transactions",
    title: "Restore rejected transactions",
    description:
      "Restore rejected transactions by id back into the Inbox (status `rejected` → `imported`). Imported rows count in account balances again; approve them with mark_transaction_reviewed to post them. Only rows currently rejected are touched; the rest are ignored. Returns how many were restored.",
    risk: "write",
    requiredScope: "reviews:write",
    input: z.object({ ids: idsInput }),
    async prepare(ctx, args) {
      const sample = await previewTransactions(ctx.userId, args.ids);
      return {
        payload: { ids: args.ids },
        title: "Restore these?",
        summary: `${args.ids.length} transaction(s) will go back to the Inbox.`,
        fields: sample.map((t) => ({ label: t.status, value: txLabel(t) })),
        affectedCount: args.ids.length,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const r = await restoreTransactionsCore(ctx.userId, payload as { ids: string[] });
      return completed(`Restored ${r.restored}`, undefined, r);
    },
  }),

  write({
    name: "bulk_categorise_transactions",
    title: "Categorise selected transactions",
    description:
      "Set one category on a list of transaction ids (up to 500), as the Inbox's bulk Categorise does. The category is also mirrored onto each transaction's split when it has exactly one (multi-split transactions keep their split categories). Ids you don't own are ignored. For text matching instead of ids, use bulk_categorise_matching_transactions. Returns how many were updated.",
    risk: "write",
    requiredScope: "reviews:write",
    input: z.object({ ids: idsInput, category: z.string().min(1).describe("category name") }),
    async prepare(ctx, args) {
      const category = await requireCategory(ctx.userId, args.category);
      const sample = await previewTransactions(ctx.userId, args.ids);
      return {
        payload: { ids: args.ids, categoryId: category.id },
        title: "Recategorise these?",
        summary: `${args.ids.length} transaction(s) → ${category.name}.`,
        fields: [{ label: "Category", value: category.name }, ...sample.map((t) => ({ label: t.date, value: txLabel(t) }))],
        affectedCount: args.ids.length,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const r = await bulkCategorizeCore(ctx.userId, payload as { ids: string[]; categoryId: string });
      return completed(`Recategorised ${r.updated}`, undefined, r);
    },
  }),

  /* ── rules ── */
  write({
    name: "create_rule",
    title: "Create rule",
    description: `Save and activate a deterministic automation rule, like the New rule dialog. ${RULE_SEMANTICS} The confirmation shows a dry run (matched of scanned recent transactions); call propose_rule first if you want to show it before asking. Returns the rule id plus the dry-run counts.`,
    risk: "sensitive",
    requiredScope: "rules:write",
    input: ruleDefinitionInput,
    async prepare(ctx, args) {
      const resolved = await resolveRuleDefinition(ctx, args);
      const preview = await rulePreview(ctx, resolved.definition);
      return {
        payload: { definition: resolved.definition, preview: { matched: preview.matchedCount, scanned: preview.scannedCount } },
        title: "Create this rule?",
        summary: `${args.name} — ${resolved.when} → ${resolved.then}.`,
        fields: [
          { label: "When", value: resolved.when },
          { label: "Then", value: resolved.then },
          { label: "Runs on import", value: args.runOnImport ? "Yes" : "No" },
          { label: "Matches now", value: `${preview.matchedCount} of ${preview.scannedCount}` },
        ],
        affectedCount: preview.matchedCount,
        warning: preview.matchedCount > 50 ? "This rule matches a large number of transactions." : undefined,
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { definition: CreateRuleInput; preview: { matched: number; scanned: number } };
      const rule = await createRuleCore(ctx.userId, p.definition);
      return completed("Rule created", rule.name, {
        id: rule.id,
        name: rule.name,
        runOnImport: rule.runOnImport,
        dryRun: p.preview,
      });
    },
  }),

  write({
    name: "update_rule",
    title: "Edit rule",
    description: `Replace an existing rule's whole definition by id (name, description, matchAll, runOnImport, conditions, actions), like the Edit rule dialog: conditions and actions you omit are removed, so send the complete set. Enabled/disabled state is untouched (use set_rule_active). ${RULE_SEMANTICS} Returns the rule id and the new definition's dry-run counts.`,
    risk: "sensitive",
    requiredScope: "rules:write",
    input: ruleDefinitionInput.extend({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const existing = (await listRulesCore(ctx.userId)).find((r) => r.id === args.id);
      if (!existing) throw new Error("Rule not found.");
      const resolved = await resolveRuleDefinition(ctx, args);
      const preview = await rulePreview(ctx, resolved.definition);
      return {
        payload: { id: args.id, definition: resolved.definition, preview: { matched: preview.matchedCount, scanned: preview.scannedCount } },
        title: "Update this rule?",
        summary: `${existing.name} → ${args.name}: ${resolved.when} → ${resolved.then}.`,
        fields: [
          { label: "Rule", value: existing.name },
          { label: "When", value: resolved.when },
          { label: "Then", value: resolved.then },
          { label: "Runs on import", value: args.runOnImport ? "Yes" : "No" },
          { label: "Matches now", value: `${preview.matchedCount} of ${preview.scannedCount}` },
        ],
        affectedCount: preview.matchedCount,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string; definition: CreateRuleInput; preview: { matched: number; scanned: number } };
      const rule = await updateRuleCore(ctx.userId, p.id, p.definition);
      return completed("Rule updated", rule.name, { id: rule.id, name: rule.name, runOnImport: rule.runOnImport, dryRun: p.preview });
    },
  }),

  write({
    name: "delete_rule",
    title: "Delete rule",
    description:
      "Delete a rule by id, with its conditions and actions. Transactions it already changed keep those changes (a rule's effects are ordinary ledger edits); its past runs stay in the activity log. It stops running on future imports. To pause instead, use set_rule_active.",
    risk: "sensitive",
    requiredScope: "rules:write",
    input: z.object({ id: z.string().uuid() }),
    async prepare(ctx, args) {
      const rule = (await listRulesCore(ctx.userId)).find((r) => r.id === args.id);
      if (!rule) throw new Error("Rule not found.");
      return {
        payload: { id: args.id },
        title: "Delete this rule?",
        summary: rule.name,
        fields: [
          { label: "Rule", value: rule.name },
          { label: "Conditions", value: String(rule.conditions.length) },
          { label: "Actions", value: String(rule.actions.length) },
        ],
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { id: string };
      const r = await deleteRuleCore(ctx.userId, p.id);
      return completed("Rule deleted", r.name, { id: p.id });
    },
  }),

  /* ── accounts ── */
  write({
    name: "create_account",
    title: "Create account",
    description:
      "Create an account, like the New account dialog. type: asset (bank account), cash, wallet (UPI/prepaid), credit_card, liability (loan/debt), investment. Only asset, cash and wallet are liquid: they feed the position, safe-to-spend and the cash forecast. `openingBalance` is in MAJOR units (enter a liability's outstanding amount as negative) and is stored in minor units with the account currency's exponent; it is the base every later transaction adds to, and it is recorded as today's balance snapshot. `openingBalanceDate` (default today) is when that balance was true. `currency` defaults to the user's display currency. `limit` (major units) is the credit limit for a credit_card or original principal for a liability. `upiId` applies to non-card accounts. includeInNetWorth (default true): when false the account is still tracked but excluded from the net worth total (which also only sums non-archived accounts in the display currency). Returns the account id.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      name: z.string().min(1).max(120),
      type: accountTypeSchema,
      openingBalance: z.number().default(0).describe("major units; negative for debt"),
      openingBalanceDate: isoDateSchema.optional(),
      currency: currencyCodeInput.optional(),
      institution: z.string().max(120).optional(),
      limit: z.number().min(0).optional().describe("major units; credit_card or liability only"),
      upiId: z.string().max(120).optional(),
      includeInNetWorth: z.boolean().default(true),
    }),
    async prepare(ctx, args) {
      const existing = await listAccounts(ctx.userId);
      if (existing.some((a) => a.name.toLowerCase() === args.name.toLowerCase())) {
        throw new Error(`You already have an account named "${args.name}".`);
      }
      if (args.limit !== undefined && args.type !== "credit_card" && args.type !== "liability") {
        throw new Error("`limit` only applies to credit_card (credit limit) or liability (original principal).");
      }
      const currencyCode = (args.currency ?? ctx.currency).toUpperCase();
      const openingBalanceDate = args.openingBalanceDate ?? todayIso();
      const payload = {
        name: args.name,
        type: args.type,
        currencyCode,
        institution: args.institution,
        upiId: args.upiId,
        openingBalance: args.openingBalance,
        openingBalanceDate,
        limit: args.limit,
        includeInNetWorth: args.includeInNetWorth,
      };
      return {
        payload,
        title: "Create account?",
        summary: args.name,
        fields: [
          { label: "Type", value: args.type },
          { label: "Opening balance", value: `${formatMajor(args.openingBalance, currencyCode)} as of ${openingBalanceDate}` },
          ...(args.institution ? [{ label: "Institution", value: args.institution }] : []),
          ...(args.limit !== undefined ? [{ label: args.type === "credit_card" ? "Credit limit" : "Original principal", value: formatMajor(args.limit, currencyCode) }] : []),
          ...(args.upiId ? [{ label: "UPI ID", value: args.upiId }] : []),
          { label: "Net worth", value: args.includeInNetWorth ? "Counted" : "Not counted" },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const account = await createAccountCore(ctx.userId, payload as never);
      return completed("Account created", account.name, {
        id: account.id,
        name: account.name,
        type: account.type,
        currency: account.currencyCode,
        openingBalanceMinor: account.openingBalanceMinor,
        openingBalanceDate: account.openingBalanceDate,
        limitMinor: account.limitMinor,
        includeInNetWorth: account.includeInNetWorth,
      });
    },
  }),

  write({
    name: "update_account",
    title: "Edit account",
    description:
      "Edit an account (found by name, archived ones included), like the Edit account dialog. Editable: name, institution, limit (major units, credit limit/principal), includeInNetWorth (false = excluded from the net worth total), archived (true hides it from pickers, the position, safe-to-spend and the forecast's starting balances and net worth; its history stays). Type and opening balance are fixed once an account exists because the forecast depends on them. Currency cannot be changed: Kosh's update never persists it (the edit screen's currency field is ignored), so passing a different currency fails instead of pretending.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      account: z.string().min(1).describe("current account name"),
      name: z.string().min(1).max(120).optional(),
      institution: z.string().max(120).optional(),
      limit: z.number().min(0).optional().describe("major units"),
      includeInNetWorth: z.boolean().optional(),
      archived: z.boolean().optional(),
      currency: currencyCodeInput.optional(),
    }),
    async prepare(ctx, args) {
      const account = await resolveAnyAccount(ctx.userId, args.account);
      if (args.currency && args.currency.toUpperCase() !== account.currencyCode) {
        throw new Error(
          `Changing an account's currency (${account.currencyCode} → ${args.currency.toUpperCase()}) is not supported: the account update does not persist currency.`,
        );
      }
      const changed = [args.name, args.institution, args.limit, args.includeInNetWorth, args.archived].some((v) => v !== undefined);
      if (!changed) throw new Error("Nothing to change: pass at least one field.");
      // Send the full form, exactly as the dialog does, merged over the
      // stored values, so the confirmation shows every field that is saved.
      const payload = {
        accountId: account.id,
        input: {
          name: args.name ?? account.name,
          institution: args.institution ?? account.institution ?? undefined,
          currencyCode: account.currencyCode,
          limit: args.limit,
          includeInNetWorth: args.includeInNetWorth ?? account.includeInNetWorth,
          isArchived: args.archived ?? account.isArchived,
        },
      };
      const fields = [{ label: "Account", value: account.name }];
      if (args.name !== undefined) fields.push({ label: "Name", value: `${account.name} → ${args.name}` });
      if (args.institution !== undefined) fields.push({ label: "Institution", value: `${account.institution ?? "—"} → ${args.institution}` });
      if (args.limit !== undefined) {
        fields.push({
          label: "Limit",
          value: `${account.limitMinor !== null ? formatMoney(account.limitMinor, account.currencyCode) : "—"} → ${formatMajor(args.limit, account.currencyCode)}`,
        });
      }
      if (args.includeInNetWorth !== undefined) fields.push({ label: "Net worth", value: args.includeInNetWorth ? "Counted" : "Not counted" });
      if (args.archived !== undefined) fields.push({ label: "Archived", value: args.archived ? "Yes" : "No" });
      return { payload, title: "Edit account?", summary: account.name, fields, undoable: true };
    },
    async execute(ctx, payload) {
      const p = payload as { accountId: string; input: Parameters<typeof updateAccountCore>[2] };
      await updateAccountCore(ctx.userId, p.accountId, p.input);
      const account = (await listAccounts(ctx.userId)).find((a) => a.id === p.accountId);
      return completed("Account updated", account?.name, account && {
        id: account.id,
        name: account.name,
        institution: account.institution,
        currency: account.currencyCode,
        limitMinor: account.limitMinor,
        includeInNetWorth: account.includeInNetWorth,
        isArchived: account.isArchived,
      });
    },
  }),

  /* ── categories & tags ── */
  write({
    name: "create_category",
    title: "Create category",
    description:
      "Create a transaction category (name up to 60 chars, optional icon and color). Names are unique per user: if one with this exact name exists, nothing is written and the existing id is returned with created=false.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      name: z.string().min(1).max(60),
      icon: z.string().max(60).optional(),
      color: z.string().max(30).optional(),
    }),
    async prepare(_ctx, args) {
      return {
        payload: args,
        title: "Create category?",
        summary: args.name,
        fields: [{ label: "Name", value: args.name }],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { name: string; icon?: string; color?: string };
      const category = await createCategoryCore(ctx.userId, p);
      if (category) return completed("Category created", category.name, { id: category.id, name: category.name, created: true });
      const existing = (await listCategories(ctx.userId)).find((c) => c.name === p.name);
      return completed("Category already exists", p.name, { id: existing?.id ?? null, name: p.name, created: false });
    },
  }),

  write({
    name: "create_tag",
    title: "Create tag",
    description:
      "Create a tag (name up to 60 chars, optional color) for use on transactions and in add_tag rule actions. Names are unique per user: if it exists, nothing is written and the existing id is returned with created=false.",
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      name: z.string().min(1).max(60),
      color: z.string().max(30).optional(),
    }),
    async prepare(_ctx, args) {
      return {
        payload: args,
        title: "Create tag?",
        summary: `#${args.name}`,
        fields: [{ label: "Name", value: `#${args.name}` }],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { name: string; color?: string };
      const tag = await createTagCore(ctx.userId, p);
      if (tag) return completed("Tag created", tag.name, { id: tag.id, name: tag.name, created: true });
      const existing = (await listTags(ctx.userId)).find((t) => t.name === p.name);
      return completed("Tag already exists", p.name, { id: existing?.id ?? null, name: p.name, created: false });
    },
  }),

  /* ── imports (the three-step wizard) ── */
  write({
    name: "upload_import",
    title: "Upload statement CSV",
    description: `Step 1 of the import wizard: upload a bank statement CSV for one account. Pass the file's text in \`csvText\` (max ${MAX_IMPORT_CHARS.toLocaleString("en-US")} characters over MCP; the wizard allows 5 MB) and its \`fileName\`. The first line must be the header row; up to 5,000 data rows. Only CSV is supported, as on screen: OFX/QFX content is refused. Nothing reaches the ledger yet: the raw rows are stored on an import in status \`uploaded\`. Returns importFileId, the CSV headers, rowCount, the suggested column mapping (field → header, guessed from header names), the first 5 raw rows, and your saved mapping templates. Next: apply_import_mapping.`,
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      account: z.string().min(1).describe("name of the account this statement belongs to; duplicates are detected against its transactions"),
      fileName: z.string().min(1).max(200),
      csvText: z.string().min(1).max(MAX_IMPORT_CHARS),
    }),
    async prepare(ctx, args) {
      const account = await resolveNamedAccount(ctx.userId, args.account);
      const head = args.csvText.slice(0, 2000).toUpperCase();
      if (head.includes("OFXHEADER") || head.includes("<OFX>")) {
        throw new Error("This looks like an OFX file. The import wizard only accepts CSV; export the statement as CSV.");
      }
      return {
        payload: { accountId: account.id, fileName: args.fileName, csvText: args.csvText },
        title: "Upload this statement?",
        summary: `${args.fileName} → ${account.name}`,
        fields: [
          { label: "File", value: args.fileName },
          { label: "Account", value: account.name },
          { label: "Size", value: `${args.csvText.length.toLocaleString("en-US")} characters` },
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const result = await uploadImportCore(ctx.userId, payload as never);
      const templates = await listImportMappings(ctx.userId);
      return completed("Statement uploaded", `${result.rowCount} rows`, {
        ...result,
        templates: templates.map((t) => ({ name: t.name, mapping: t.mapping, dateFormat: t.dateFormat })),
      });
    },
  }),

  write({
    name: "apply_import_mapping",
    title: "Map import columns",
    description: `Step 2 of the import wizard: map CSV columns to fields and parse every row. Give either \`mapping\` (field → exact CSV header; fields: date, valueDate, description, amount, debit, credit, externalId, upiReference, utrNumber, narration; required: date, description and amount or debit/credit) or \`template\` (name of a saved mapping, which also supplies its date format). \`dateFormat\` is one of ${IMPORT_DATE_FORMATS.join(", ")} (default dd/MM/yyyy, as on screen). Amounts are parsed into minor units of the account's currency: a single signed amount column keeps its sign; with debit/credit, a debit becomes negative and a credit positive. A row is an \`error\` (skipped) when its date, amount or description can't be parsed; a \`duplicate\` when it matches an existing transaction on the account (same external id, or same date+amount+description hash, or same amount within ±1 day) or an identical earlier row in the same file; otherwise \`pending\` (ready). \`saveAsTemplate\` stores the mapping for reuse. Can be re-run until committed. Returns counts and the preview rows (page/pageSize, all rows reachable).`,
    risk: "write",
    requiredScope: "transactions:write",
    input: z.object({
      importFileId: z.string().uuid(),
      mapping: z.partialRecord(importFieldSchema, z.string().min(1)).optional(),
      template: z.string().optional().describe("saved template name, instead of mapping"),
      dateFormat: z.enum(IMPORT_DATE_FORMATS).optional(),
      saveAsTemplate: z.string().max(100).optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(5000).default(200),
    }),
    async prepare(ctx, args) {
      const file = await requireImport(ctx.userId, args.importFileId);
      if (file.status === "committed") throw new Error("Import already committed.");
      let mapping = args.mapping;
      let dateFormat: string = args.dateFormat ?? "dd/MM/yyyy";
      if (args.template) {
        if (args.mapping) throw new Error("Pass either `mapping` or `template`, not both.");
        const templates = await listImportMappings(ctx.userId);
        const template = templates.find((t) => t.name.toLowerCase() === args.template!.toLowerCase());
        if (!template) {
          throw new Error(`No saved template named "${args.template}". Saved: ${templates.map((t) => t.name).join(", ") || "none"}.`);
        }
        mapping = template.mapping as typeof mapping;
        if (!args.dateFormat && template.dateFormat) dateFormat = template.dateFormat;
      }
      if (!mapping) throw new Error("Pass `mapping` or `template`.");
      if (!mapping.date || !mapping.description || !(mapping.amount || mapping.debit || mapping.credit)) {
        throw new Error("Map at least a date, a description, and an amount (or debit/credit).");
      }
      const headers = file.columns ?? [];
      const unknown = Object.values(mapping).filter((h) => h && !headers.includes(h));
      if (unknown.length) {
        throw new Error(`Not a column in this file: ${unknown.join(", ")}. Columns: ${headers.join(", ")}.`);
      }
      const input: ApplyMappingInput = {
        importFileId: file.id,
        mapping: mapping as ApplyMappingInput["mapping"],
        dateFormat,
        saveAsTemplate: args.saveAsTemplate?.trim() || undefined,
      };
      return {
        payload: { input, page: args.page, pageSize: args.pageSize },
        title: "Apply this mapping?",
        summary: file.fileName,
        fields: [
          ...Object.entries(mapping).map(([field, header]) => ({ label: field, value: String(header) })),
          { label: "Date format", value: dateFormat },
          ...(input.saveAsTemplate ? [{ label: "Save as template", value: input.saveAsTemplate }] : []),
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { input: ApplyMappingInput; page: number; pageSize: number };
      const counts = await applyImportMappingCore(ctx.userId, p.input);
      const preview = await importPreview(ctx.userId, p.input.importFileId, p.page, p.pageSize);
      return completed(
        "Mapping applied",
        `${counts.ready} ready, ${counts.duplicates} duplicates, ${counts.errors} unparseable`,
        preview,
      );
    },
  }),

  write({
    name: "commit_import",
    title: "Commit import",
    description:
      "Step 3 of the import wizard: write the previewed rows into the ledger. Every `pending` row not listed in `excludeRowIds` becomes a transaction with status `imported` (type income when the amount is >= 0, else expense; dated at the parsed date; in the account's currency). Imported transactions count in the account balance immediately and wait in the Inbox for review. Duplicates are excluded by default, as on screen, and marked rejected; list the ones you want anyway in `includeDuplicateRowIds` (they are imported flagged as a suspected duplicate of the matched transaction; only near-duplicates can be forced: a row whose external id is already used on the account, or that has the same date+amount+description as an already imported transaction, is refused because the ledger keeps both unique per account). Error rows are always skipped. All-or-nothing: the account balance is recomputed and the import sealed in one transaction, then every active rule with runOnImport runs on the new transactions. A committed import can't be committed again or deleted. Returns created and rulesApplied.",
    risk: "sensitive",
    requiredScope: "transactions:write",
    input: z.object({
      importFileId: z.string().uuid(),
      excludeRowIds: z.array(z.string().uuid()).max(5000).default([]).describe("ready rows to skip"),
      includeDuplicateRowIds: z.array(z.string().uuid()).max(5000).default([]).describe("duplicate rows to import anyway"),
    }),
    async prepare(ctx, args) {
      const file = await requireImport(ctx.userId, args.importFileId);
      if (file.status !== "previewed") {
        throw new Error(
          file.status === "committed" ? "Import already committed." : "Map and preview the file (apply_import_mapping) before committing.",
        );
      }
      const byId = new Map(file.rows.map((r) => [r.id, r]));
      for (const id of args.excludeRowIds) if (!byId.has(id)) throw new Error(`Row ${id} is not part of this import.`);
      for (const id of args.includeDuplicateRowIds) {
        const row = byId.get(id);
        if (!row) throw new Error(`Row ${id} is not part of this import.`);
        if (row.status !== "duplicate") throw new Error(`Row ${row.rowIndex + 1} is not a duplicate (status ${row.status}).`);
      }
      const include = new Set(args.includeDuplicateRowIds);
      const excluded = new Set(args.excludeRowIds.filter((id) => !include.has(id)));
      for (const row of file.rows) if (row.status === "duplicate" && !include.has(row.id)) excluded.add(row.id);
      const importing = file.rows.filter(
        (r) => (r.status === "pending" || include.has(r.id)) && !excluded.has(r.id),
      );
      const willImport = importing.length;
      // The ledger keeps two per-account unique keys: the provider reference
      // (external id) and, among imported rows, the date+amount+description
      // hash. A forced duplicate that collides on either — with the matched
      // transaction or another row of this batch — would abort the whole
      // all-or-nothing commit, so it is refused up front, by row number.
      const hashOf = (r: (typeof file.rows)[number]) =>
        r.parsedDate && r.parsedAmountMinor !== null
          ? computeImportHash({
              accountId: file.accountId!,
              date: r.parsedDate,
              amountMinor: r.parsedAmountMinor,
              description: r.parsedDescription ?? "Imported transaction",
            })
          : null;
      for (const id of include) {
        const row = byId.get(id)!;
        const ref = row.parsedExternalId;
        const hash = hashOf(row);
        const others = importing.filter((r) => r.id !== row.id);
        const matched = row.duplicateOfTransaction
          ? await getTransaction(ctx.userId, row.duplicateOfTransaction.id)
          : null;
        if (ref && (others.some((r) => r.parsedExternalId === ref) || matched?.externalId === ref)) {
          throw new Error(
            `Row ${row.rowIndex + 1} can't be imported anyway: its external id "${ref}" is already used on this account (each reference is unique per account).`,
          );
        }
        if (
          hash &&
          (others.some((r) => hashOf(r) === hash) || (matched?.importFileId && matched.importHash === hash))
        ) {
          throw new Error(
            `Row ${row.rowIndex + 1} can't be imported anyway: an imported transaction with the same date, amount and description already exists on this account (imports are unique on that triple).`,
          );
        }
      }
      const errors = file.rows.filter((r) => r.status === "error").length;
      return {
        payload: { importFileId: file.id, excludedRowIds: [...excluded], includeDuplicateRowIds: [...include] },
        title: "Commit this import?",
        summary: `${willImport} transaction(s) from ${file.fileName} into ${file.account?.name ?? "the account"}.`,
        fields: [
          { label: "Will import", value: String(willImport) },
          { label: "Excluded / rejected", value: String(excluded.size) },
          { label: "Duplicates included", value: String(include.size) },
          { label: "Unparseable (skipped)", value: String(errors) },
        ],
        affectedCount: willImport,
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { importFileId: string; excludedRowIds: string[]; includeDuplicateRowIds: string[] };
      if (p.includeDuplicateRowIds.length) {
        await includeDuplicateRowsCore(ctx.userId, { rowIds: p.includeDuplicateRowIds });
      }
      const r = await commitImportCore(ctx.userId, { importFileId: p.importFileId, excludedRowIds: p.excludedRowIds });
      return completed(`Imported ${r.created}`, `${r.rulesApplied} rule change(s) applied`, {
        importFileId: p.importFileId,
        ...r,
      });
    },
  }),

  write({
    name: "delete_import",
    title: "Delete import",
    description:
      "Abandon an uncommitted import (uploaded or previewed), deleting the file and its parsed rows. Nothing in the ledger changes. Committed imports are ledger history and cannot be deleted.",
    risk: "sensitive",
    requiredScope: "transactions:write",
    input: z.object({ importFileId: z.string().uuid() }),
    async prepare(ctx, args) {
      const file = await requireImport(ctx.userId, args.importFileId);
      if (file.status === "committed") throw new Error("Committed imports are part of the ledger history.");
      return {
        payload: { importFileId: file.id },
        title: "Delete this import?",
        summary: file.fileName,
        fields: [
          { label: "File", value: file.fileName },
          { label: "Rows", value: String(file.rowCount) },
          { label: "Status", value: file.status },
        ],
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { importFileId: string };
      const r = await deleteImportCore(ctx.userId, p.importFileId);
      return completed("Import deleted", r.fileName, { importFileId: p.importFileId });
    },
  }),

  /* ── settings ── */
  write({
    name: "update_settings",
    title: "Update settings",
    description: `Change display settings, as the Settings screen does. currency (${SETTINGS_CURRENCIES.join(", ")}): the currency dashboard and report totals are computed in, the default for amounts tools don't specify, and the only currency summed into net worth; transactions keep their stored currency and nothing is converted. locale (${SETTINGS_LOCALES.join(", ")}): number and date formatting. dateFormat (${SETTINGS_DATE_FORMATS.join(", ")}): how dates are displayed. Pass only what changes.`,
    risk: "write",
    requiredScope: "settings:write",
    input: z.object({
      currency: z.enum(SETTINGS_CURRENCIES).optional(),
      locale: z.enum(SETTINGS_LOCALES).optional(),
      dateFormat: z.enum(SETTINGS_DATE_FORMATS).optional(),
    }),
    async prepare(ctx, args) {
      const current = await getUserSettings(ctx.userId);
      const payload = {
        ...(args.currency ? { currencyCode: args.currency } : {}),
        ...(args.locale ? { locale: args.locale } : {}),
        ...(args.dateFormat ? { dateFormat: args.dateFormat } : {}),
      };
      if (Object.keys(payload).length === 0) throw new Error("Nothing to change: pass currency, locale or dateFormat.");
      return {
        payload,
        title: "Update settings?",
        summary: "Display settings",
        fields: [
          ...(args.currency ? [{ label: "Currency", value: `${current.currencyCode} → ${args.currency}` }] : []),
          ...(args.locale ? [{ label: "Locale", value: `${current.locale} → ${args.locale}` }] : []),
          ...(args.dateFormat ? [{ label: "Date format", value: `${current.dateFormat} → ${args.dateFormat}` }] : []),
        ],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      await updateUserSettingsCore(ctx.userId, payload as never);
      const s = await getUserSettings(ctx.userId);
      return completed("Settings saved", undefined, {
        currency: s.currencyCode,
        locale: s.locale,
        dateFormat: s.dateFormat,
      });
    },
  }),

  /* ── open finance (read-only towards the bank) ── */
  write({
    name: "register_open_finance_connection",
    title: "Register Open Finance connection",
    description:
      "Register a Pluggy connection the user already created at meu.pluggy.ai, by its Item ID (a uuid copied from the Pluggy dashboard, not a secret). Hermes only remembers the Item ID: it never creates, changes or deletes a bank connection, asks for consent, or receives bank credentials, so none are accepted here. Nothing is read until a sync runs (sync_open_finance_now or the daily job). Returns the connection id.",
    risk: "write",
    requiredScope: "automations:write",
    input: z.object({
      itemId: z.string().trim().uuid("Paste the Item ID copied from the Pluggy dashboard."),
      label: z.string().trim().max(120).optional(),
    }),
    async prepare(_ctx, args) {
      return {
        payload: { itemId: args.itemId, label: args.label },
        title: "Register this connection?",
        summary: args.label ?? "Pluggy Item",
        fields: [{ label: "Label", value: args.label ?? "—" }],
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const connection = await registerConnectionCore(ctx.userId, payload as never);
      return completed("Connection registered", "Run a sync to pull it in.", {
        connectionId: connection.id,
        label: connection.label,
      });
    },
  }),

  write({
    name: "remove_open_finance_connection",
    title: "Remove Open Finance connection",
    description:
      "Forget an Open Finance connection by id. Only the link to the provider goes: the accounts and transactions it produced stay as ledger history and keep counting. Syncing stops. The bank connection at Pluggy is not touched.",
    risk: "sensitive",
    requiredScope: "automations:write",
    input: z.object({ connectionId: z.string().uuid() }),
    async prepare(ctx, args) {
      const connection = await requireConnection(ctx.userId, args.connectionId);
      return {
        payload: { connectionId: connection.id },
        title: "Remove this connection?",
        summary: connectionName(connection),
        fields: [
          { label: "Connection", value: connectionName(connection) },
          { label: "Linked accounts", value: connection.links.map((l) => l.accountName ?? l.providerName ?? "ignored").join(", ") || "none" },
        ],
        warning: "Your accounts and history are kept; only future syncing stops.",
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { connectionId: string };
      await removeConnectionCore(ctx.userId, p.connectionId);
      return completed("Connection removed", "Your accounts and history were kept.", { connectionId: p.connectionId });
    },
  }),

  write({
    name: "sync_open_finance_now",
    title: "Sync Open Finance now",
    description:
      "Run a sync for one connection now (the Sync now button). Read-only towards the bank: it only reads from Pluggy. It links or creates accounts, upserts transactions by provider id (re-reading from 8 days before the last sync, or 12 months the first time; rows you already reviewed or posted are never overwritten), records each account's balance as a snapshot dated at the provider's observation time — the balance the position, safe-to-spend and forecast start from — turns closed card statements into confirmed cycles, converts a matched card-bill payment into a transfer, and runs runOnImport rules on new rows. If the Item needs attention at meu.pluggy.ai (login error, expired consent) it stops without writing. Returns status (ok, partial, error, skipped), counts {seen, created, updated, duplicates, needsReview, skipped} and the provider message verbatim. skipped also means Open Finance is switched off on this installation or a sync is already running.",
    risk: "write",
    requiredScope: "automations:write",
    input: z.object({ connectionId: z.string().uuid() }),
    async prepare(ctx, args) {
      const connection = await requireConnection(ctx.userId, args.connectionId);
      return {
        payload: { connectionId: connection.id },
        title: "Sync now?",
        summary: connectionName(connection),
        fields: [{ label: "Connection", value: connectionName(connection) }],
        undoable: false,
      };
    },
    async execute(ctx, payload) {
      const p = payload as { connectionId: string };
      const summary = await syncConnection(ctx.userId, p.connectionId, { trigger: "manual" });
      const detail =
        summary.status === "ok" || summary.status === "partial"
          ? `${summary.counts.created} new, ${summary.counts.updated} updated, ${summary.counts.needsReview} to review.`
          : summary.message ?? undefined;
      return completed(
        `Sync ${summary.status}`,
        detail,
        summary,
        summary.status === "error" ? "temporary_failure" : "completed",
      );
    },
  }),

  write({
    name: "update_open_finance_account_link",
    title: "Relink Open Finance account",
    description:
      "Override which Hermes account a provider account feeds (link id from get_open_finance_status). `account` is an account name, or null to mark the provider account as ignored (not tracked). The previous account keeps everything already imported into it. The sync watermark is cleared, so the next sync re-reads that provider account's full history into the new account (provider ids prevent duplicates within an account). isSyncEnabled defaults to true when linked and false when ignored.",
    risk: "write",
    requiredScope: "automations:write",
    input: z.object({
      linkId: z.string().uuid(),
      account: z.string().min(1).nullable().describe("account name, or null to ignore"),
      isSyncEnabled: z.boolean().optional(),
    }),
    async prepare(ctx, args) {
      const connections = await listConnections(ctx.userId);
      const link = connections.flatMap((c) => c.links).find((l) => l.id === args.linkId);
      if (!link) throw new Error("Link not found.");
      const account = args.account === null ? null : await resolveNamedAccount(ctx.userId, args.account);
      return {
        payload: { linkId: link.id, accountId: account?.id ?? null, isSyncEnabled: args.isSyncEnabled },
        title: "Change this link?",
        summary: link.providerName ?? "Provider account",
        fields: [
          { label: "Provider account", value: link.providerName ?? link.id },
          { label: "From", value: link.accountName ?? "ignored" },
          { label: "To", value: account?.name ?? "ignored" },
        ],
        warning: "The next sync will re-read this account's history.",
        undoable: true,
      };
    },
    async execute(ctx, payload) {
      const updated = await updateAccountLinkCore(ctx.userId, payload as never);
      return completed("Link updated", "The next sync will re-read this account's history.", {
        linkId: updated.id,
        accountId: updated.accountId,
        linkMode: updated.linkMode,
        isSyncEnabled: updated.isSyncEnabled,
      });
    },
  }),
];
