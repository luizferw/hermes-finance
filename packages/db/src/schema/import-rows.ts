import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { importRowStatusEnum } from "./enums";
import { timestamps } from "./helpers";
import { importFiles } from "./imports";
import { transactions } from "./transactions";

/**
 * One row per CSV line. Raw values are preserved verbatim; parsed fields are
 * filled in once a mapping is applied. Committed rows link to the transaction
 * they created, preserving provenance both ways.
 */
export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importFileId: uuid("import_file_id")
      .notNull()
      .references(() => importFiles.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    /** Raw CSV cells keyed by source column name. */
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    status: importRowStatusEnum("status").notNull().default("pending"),
    parsedDate: date("parsed_date", { mode: "string" }),
    parsedAmountMinor: bigint("parsed_amount_minor", { mode: "number" }),
    parsedDescription: text("parsed_description"),
    parsedExternalId: text("parsed_external_id"),
    parseError: text("parse_error"),
    /** Existing transaction this row appears to duplicate. */
    duplicateOfTransactionId: uuid("duplicate_of_transaction_id").references(
      () => transactions.id,
      { onDelete: "set null" },
    ),
    /** Transaction created when this row was committed. */
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("import_rows_file_row_unique").on(t.importFileId, t.rowIndex),
    index("import_rows_file_idx").on(t.importFileId),
    index("import_rows_status_idx").on(t.importFileId, t.status),
  ],
);
