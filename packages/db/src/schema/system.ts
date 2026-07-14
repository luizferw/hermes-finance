import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./helpers";
import { users } from "./auth";

/**
 * File attachments. Entity references are polymorphic
 * (entityType + entityId), so no FK — module code validates targets.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storagePath: text("storage_path").notNull(),
    ...timestamps,
  },
  (t) => [index("attachments_entity_idx").on(t.entityType, t.entityId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Dotted action name, e.g. "transaction.approved", "rule.executed". */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    /** Action-specific context: changed fields, counts, befores/afters. */
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("audit_logs_user_idx").on(t.userId, t.createdAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
  ],
);

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** ISO 3166-1 alpha-2 region chosen at onboarding; drives locale/FY defaults. */
  country: text("country").notNull().default("IN"),
  /** Display currency for dashboards and reports. */
  currencyCode: text("currency_code").notNull().default("INR"),
  locale: text("locale").notNull().default("en-IN"),
  dateFormat: text("date_format").notNull().default("dd MMM yyyy"),
  /** First month of the financial year (1-12). India = 4 (Apr–Mar). */
  financialYearStartMonth: smallint("financial_year_start_month")
    .notNull()
    .default(4),
  ...timestamps,
});

/**
 * One row per user per day recording the computed financial-confidence score.
 * Powers the home page's confidence trend and the "stayed on top" habit streak
 * (consecutive `onTop` days). Written idempotently on each home render.
 */
export const confidenceSnapshots = pgTable(
  "confidence_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    /** 0–100 composite. */
    score: smallint("score").notNull(),
    /** Band slug: secure | steady | finding | stretched. */
    band: text("band").notNull(),
    /** Inbox clear AND nothing overdue on this day — the streak signal. */
    onTop: boolean("on_top").notNull().default(false),
    /** Per-factor breakdown at snapshot time, for later analysis. */
    factors: jsonb("factors").$type<
      Array<{ key: string; score: number; status: string }>
    >(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("confidence_snapshots_user_date_unique").on(t.userId, t.date),
    index("confidence_snapshots_user_idx").on(t.userId),
  ],
);

/** Health record per background job; pg-boss owns scheduling state. */
export const systemJobs = pgTable(
  "system_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    schedule: text("schedule"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    lastDurationMs: integer("last_duration_ms"),
    ...timestamps,
  },
  (t) => [uniqueIndex("system_jobs_name_unique").on(t.name)],
);
