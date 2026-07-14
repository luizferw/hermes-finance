import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { transactionStatusEnum, transactionTypeEnum } from "./enums";
import { encryptedText, timestamps } from "./helpers";
import { users } from "./auth";
import { accounts } from "./accounts";
import { categories, tags } from "./taxonomy";
import { importFiles } from "./imports";
import { bills, recurringTransactions } from "./planning";

/**
 * The user-visible ledger object.
 *
 * Sign convention: `amountMinor` is signed from the perspective of
 * `accountId` — negative for money leaving the account (expenses, transfers
 * out), positive for money arriving (income). Transfers store the source in
 * `accountId` and the destination in `transferAccountId` with a negative
 * amount; the destination side is derived, which keeps v0 simple while
 * leaving room for strict double-entry later.
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    transferAccountId: uuid("transfer_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    type: transactionTypeEnum("type").notNull(),
    status: transactionStatusEnum("status").notNull().default("posted"),
    /** Booking date shown to the user. */
    date: date("date", { mode: "string" }).notNull(),
    /** Bank value date, when it differs (common on Indian statements). */
    valueDate: date("value_date", { mode: "string" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    /** Normalized, human-friendly description. */
    description: text("description").notNull(),
    /** Normalized merchant/payee name (rule "rename merchant" writes here). */
    merchant: text("merchant"),
    /** Untouched description exactly as imported. Never rewritten. */
    rawDescription: text("raw_description"),
    /** Full narration field from bank statements. Encrypted at rest. */
    narration: encryptedText("narration"),
    notes: encryptedText("notes"),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    billId: uuid("bill_id").references(() => bills.id, {
      onDelete: "set null",
    }),
    // --- provenance -------------------------------------------------------
    /** External/bank-side identifier, used for exact duplicate detection. */
    externalId: text("external_id"),
    /** UPI transaction reference (india-first). Encrypted at rest. */
    upiReference: encryptedText("upi_reference"),
    /** Counterparty UPI ID, e.g. merchant@okhdfcbank. Encrypted at rest. */
    counterpartyUpiId: encryptedText("counterparty_upi_id"),
    /** NEFT/RTGS/IMPS UTR number. Encrypted at rest. */
    utrNumber: encryptedText("utr_number"),
    /** Stable hash of (account, date, amount, raw description) for dedupe. */
    importHash: text("import_hash"),
    importFileId: uuid("import_file_id").references(() => importFiles.id, {
      onDelete: "set null",
    }),
    recurringTransactionId: uuid("recurring_transaction_id").references(
      () => recurringTransactions.id,
      { onDelete: "set null" },
    ),
    /** Set when import flagged this as a likely duplicate of an existing tx. */
    suspectedDuplicateOfId: uuid("suspected_duplicate_of_id").references(
      (): AnyPgColumn => transactions.id,
      { onDelete: "set null" },
    ),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("transactions_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      "transactions_amount_sign_check",
      sql`(${t.type}::text = 'income' AND ${t.amountMinor} > 0)
        OR (${t.type}::text IN ('expense', 'transfer') AND ${t.amountMinor} < 0)
        OR (${t.type}::text IN ('adjustment', 'opening_balance') AND ${t.amountMinor} <> 0)`,
    ),
    check(
      "transactions_transfer_account_check",
      sql`(${t.type}::text = 'transfer' AND ${t.transferAccountId} IS NOT NULL)
        OR (${t.type}::text <> 'transfer' AND ${t.transferAccountId} IS NULL)`,
    ),
    foreignKey({
      columns: [t.accountId, t.userId],
      foreignColumns: [accounts.id, accounts.userId],
      name: "transactions_account_owner_fk",
    }).onDelete("cascade"),
    index("transactions_user_date_idx").on(t.userId, t.date),
    index("transactions_account_date_idx").on(t.accountId, t.date),
    index("transactions_user_status_idx").on(t.userId, t.status),
    index("transactions_category_idx").on(t.categoryId),
    index("transactions_bill_idx").on(t.billId),
    index("transactions_import_file_idx").on(t.importFileId),
    index("transactions_import_hash_idx").on(t.importHash),
    index("transactions_external_id_idx").on(t.externalId),
    uniqueIndex("transactions_import_hash_unique")
      .on(t.accountId, t.importHash)
      .where(
        sql`${t.importHash} IS NOT NULL AND ${t.importFileId} IS NOT NULL AND ${t.deletedAt} IS NULL`,
      ),
    uniqueIndex("transactions_external_id_unique")
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * Money movement lines. Every transaction has at least one split; multi-split
 * transactions break the total across categories. Split amounts must sum to
 * the transaction amount (enforced by the ledger domain logic).
 */
export const transactionSplits = pgTable(
  "transaction_splits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("transaction_splits_transaction_idx").on(t.transactionId)],
);

export const transactionTags = pgTable(
  "transaction_tags",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] })],
);

/** Open key/value metadata for fields we don't model yet (broker refs, etc.). */
export const transactionMetadata = pgTable(
  "transaction_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("transaction_metadata_tx_key_unique").on(
      t.transactionId,
      t.key,
    ),
  ],
);
