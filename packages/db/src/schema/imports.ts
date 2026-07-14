import {
  integer,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { importFileStatusEnum } from "./enums";
import { timestamps } from "./helpers";
import { users } from "./auth";
import { accounts } from "./accounts";

/**
 * Column-to-field mapping used by an import. Keys are Kosh fields
 * (date, amount, debit, credit, description, externalId, valueDate, ...),
 * values are source CSV column names.
 */
export type ImportColumnMapping = Record<string, string>;

export const importFiles = pgTable(
  "import_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Account the rows will be imported into. */
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    fileName: text("file_name").notNull(),
    status: importFileStatusEnum("status").notNull().default("uploaded"),
    rowCount: integer("row_count").notNull().default(0),
    /** Header row of the source file, in order. */
    columns: jsonb("columns").$type<string[]>(),
    mapping: jsonb("mapping").$type<ImportColumnMapping>(),
    /** Date format hint, e.g. "dd/MM/yyyy" for Indian bank statements. */
    dateFormat: text("date_format"),
    errorMessage: text("error_message"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("import_files_user_id_idx").on(t.userId)],
);

/** Saved, reusable mapping templates ("HDFC statement", "ICICI credit card"). */
export const importMappings = pgTable(
  "import_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mapping: jsonb("mapping").$type<ImportColumnMapping>().notNull(),
    dateFormat: text("date_format"),
    ...timestamps,
  },
  (t) => [index("import_mappings_user_id_idx").on(t.userId)],
);
