import "server-only";
import type { db } from "@kosh/db";

/**
 * A Drizzle transaction handle.
 *
 * The sync writes each account inside its own transaction, so every helper
 * takes this rather than reaching for the module-level `db`: a helper that
 * bypassed the handle would commit outside the transaction and survive a
 * rollback.
 */
export type Trx = Parameters<Parameters<typeof db.transaction>[0]>[0];
