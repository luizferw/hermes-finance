/**
 * Open Finance connections and their sync bookkeeping.
 *
 * Hermes never creates, updates or deletes a connection: the user does that at
 * meu.pluggy.ai and pastes the resulting item id here. So there are no
 * credentials in these tables — the client id and secret belong to the
 * deployment and live in the environment. What is stored is the reference to
 * somebody else's record, the decision about which Hermes account it maps to,
 * and an audit trail of every sync.
 *
 * All three tables are new. No Kosh-owned table is altered, which is what keeps
 * upstream merges predictable (see docs/UPSTREAM.md).
 */
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { accounts } from "./accounts";
import { creditCards } from "./finance";
import { encryptedText, timestamps } from "./helpers";

/** How a provider account came to be attached to a Hermes account. */
export type OpenFinanceLinkMode =
  | "auto_created"
  | "matched_existing"
  | "manual"
  | "ignored"
  | "unsupported";

/** Which rule matched, so the settings screen can explain the decision. */
export type OpenFinanceLinkConfidence = "exact_mask" | "institution_mask" | "name";

export interface OpenFinanceSyncStats {
  /** Card rows that were the bill settlement, skipped rather than double booked (PRD R4). */
  skippedCardPayments?: number;
  skippedZeroAmount?: number;
  /** Provider accounts whose type Hermes has no model for. */
  unsupportedAccounts?: number;
  /** Accounts that failed while others succeeded, leaving the run partial. */
  failedAccounts?: { providerAccountId: string; error: string }[];
  /** Difference between the provider balance and the ledger, on a matched account. */
  balanceDrift?: { accountId: string; driftMinor: number }[];
  perAccount?: Record<string, { seen: number; created: number; updated: number }>;
}

/**
 * One row per Pluggy Item — a user's connection to one institution.
 *
 * `itemId` is stored in plain text on purpose. It is an opaque uuid that is
 * useless without the deployment's client secret, and it is the key every sync
 * looks a connection up by; an `encryptedText` column could not be indexed or
 * filtered, because AES-GCM ciphertext is non-deterministic.
 */
export const openFinanceConnections = pgTable("open_finance_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("pluggy"),
  itemId: text("item_id").notNull(),
  /** What the user calls this connection; falls back to the connector name. */
  label: text("label"),
  connectorId: integer("connector_id"),
  connectorName: text("connector_name"),
  connectorImageUrl: text("connector_image_url"),
  /** The provider's own item status: UPDATED, LOGIN_ERROR, WAITING_USER_INPUT, … */
  status: text("status").notNull().default("unknown"),
  executionStatus: text("execution_status"),
  /**
   * When the provider last reached the institution. This, not our sync time, is
   * the age of the data the user is looking at (PRD R8).
   */
  providerLastUpdatedAt: timestamp("provider_last_updated_at", { withTimezone: true }),
  consentExpiresAt: timestamp("consent_expires_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  /** running | ok | partial | error. `running` doubles as the concurrency claim. */
  lastSyncStatus: text("last_sync_status"),
  /** The error name only, never its message — the same rule system_jobs follows. */
  lastSyncError: text("last_sync_error"),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, (t) => [
  check("open_finance_connections_provider_check", sql`${t.provider} ~ '^[a-z_]+$'`),
  uniqueIndex("open_finance_connections_user_item_unique").on(t.userId, t.provider, t.itemId),
  // Lets child tables carry a composite FK on (id, userId), so a row can never
  // reference a connection belonging to another tenant.
  uniqueIndex("open_finance_connections_id_user_unique").on(t.id, t.userId),
  index("open_finance_connections_user_idx").on(t.userId),
]);

/**
 * The mapping between one provider account and one Hermes account, plus the
 * watermark that makes the next sync incremental.
 *
 * The link is what makes a second sync idempotent at the account level: without
 * it, every run would have to guess again which Hermes account a provider
 * account belongs to, and a different guess would fork the history.
 */
export const openFinanceAccountLinks = pgTable("open_finance_account_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => openFinanceConnections.id, { onDelete: "cascade" }),
  providerAccountId: text("provider_account_id").notNull(),
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
  creditCardId: uuid("credit_card_id").references(() => creditCards.id, { onDelete: "set null" }),
  /** BANK or CREDIT, as the provider classifies it. */
  providerType: text("provider_type").notNull(),
  providerSubtype: text("provider_subtype"),
  providerName: text("provider_name"),
  /**
   * The account number, or a card's last four digits. Encrypted, and therefore
   * matched in memory only — never in a WHERE clause.
   */
  providerNumberMask: encryptedText("provider_number_mask"),
  currencyCode: text("currency_code").notNull(),
  linkMode: text("link_mode").$type<OpenFinanceLinkMode>().notNull(),
  linkConfidence: text("link_confidence").$type<OpenFinanceLinkConfidence>(),
  /** Human-readable reason, shown in settings so the decision can be overridden. */
  linkDecisionNote: text("link_decision_note"),
  /** Last day already fetched. The next run re-reads a few days back from here. */
  syncedThrough: date("synced_through", { mode: "string" }),
  lastTransactionSyncedAt: timestamp("last_transaction_synced_at", { withTimezone: true }),
  providerBalanceMinor: bigint("provider_balance_minor", { mode: "number" }),
  providerBalanceObservedAt: timestamp("provider_balance_observed_at", { withTimezone: true }),
  /**
   * Set once, when the opening balance was back-solved so the ledger lands on
   * the provider balance. Its presence is what stops that from happening twice.
   */
  openingBalanceDerivedAt: timestamp("opening_balance_derived_at", { withTimezone: true }),
  isSyncEnabled: boolean("is_sync_enabled").notNull().default(true),
  ...timestamps,
}, (t) => [
  check("open_finance_account_links_currency_code_check", sql`${t.currencyCode} ~ '^[A-Z]{3}$'`),
  uniqueIndex("open_finance_account_links_connection_account_unique")
    .on(t.connectionId, t.providerAccountId),
  // One Hermes account is fed by at most one provider account. Two would
  // interleave two institutions' histories into a single ledger.
  uniqueIndex("open_finance_account_links_account_unique")
    .on(t.accountId)
    .where(sql`${t.accountId} IS NOT NULL`),
  index("open_finance_account_links_user_idx").on(t.userId),
  index("open_finance_account_links_connection_idx").on(t.connectionId),
]);

/**
 * One row per sync attempt, in the shape PRD §9.20 gives ImportBatch.
 *
 * §9.20's `file_hash` has no meaning for a provider sync and is deliberately
 * absent rather than present and always null.
 */
export const openFinanceSyncRuns = pgTable("open_finance_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .references(() => openFinanceConnections.id, { onDelete: "set null" }),
  /** PRD §9.19 ImportSource. */
  source: text("source").notNull().default("OPEN_FINANCE"),
  institution: text("institution"),
  /** scheduled | manual */
  trigger: text("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** running | ok | partial | error */
  status: text("status").notNull().default("running"),
  recordsSeen: integer("records_seen").notNull().default(0),
  recordsCreated: integer("records_created").notNull().default(0),
  recordsUpdated: integer("records_updated").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  /** Rows a human has to judge: an ambiguous duplicate, a bill that will not reconcile. */
  needsReview: integer("needs_review").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  error: text("error"),
  stats: jsonb("stats").$type<OpenFinanceSyncStats>().notNull().default({}),
}, (t) => [
  index("open_finance_sync_runs_user_started_idx").on(t.userId, t.startedAt),
  index("open_finance_sync_runs_connection_idx").on(t.connectionId),
]);
