import {
  bigint,
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accountTypeEnum } from "./enums";
import { encryptedText, timestamps } from "./helpers";
import { users } from "./auth";

/**
 * Money containers. All money is stored as integer minor units (paise, cents)
 * with the ISO 4217 currency code alongside. Never floating point.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: accountTypeEnum("type").notNull(),
    currencyCode: text("currency_code").notNull().default("INR"),
    institution: text("institution"),
    /** Last 4 digits or masked account number — never the full number. Encrypted at rest. */
    accountNumberMask: encryptedText("account_number_mask"),
    /** UPI handle attached to this account (india-first). Encrypted at rest. */
    upiId: encryptedText("upi_id"),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "number" })
      .notNull()
      .default(0),
    openingBalanceDate: date("opening_balance_date", { mode: "string" }),
    /** Cached current balance, maintained by the ledger module. */
    currentBalanceMinor: bigint("current_balance_minor", { mode: "number" })
      .notNull()
      .default(0),
    /** Credit limit for credit cards, original principal for liabilities. */
    limitMinor: bigint("limit_minor", { mode: "number" }),
    includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
    isArchived: boolean("is_archived").notNull().default(false),
    notes: encryptedText("notes"),
    ...timestamps,
  },
  (t) => [
    check("accounts_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    index("accounts_user_id_idx").on(t.userId),
    uniqueIndex("accounts_id_user_unique").on(t.id, t.userId),
    uniqueIndex("accounts_user_name_unique").on(t.userId, t.name),
  ],
);

/** Daily balance snapshots powering trend charts and account history. */
export const accountBalances = pgTable(
  "account_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    balanceMinor: bigint("balance_minor", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull(),
    ...timestamps,
  },
  (t) => [
    check("account_balances_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
    uniqueIndex("account_balances_account_date_unique").on(t.accountId, t.date),
    index("account_balances_date_idx").on(t.date),
  ],
);
