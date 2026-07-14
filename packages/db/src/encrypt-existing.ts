/**
 * One-time backfill: encrypt existing plaintext values in the columns that are
 * now `encryptedText`. Safe to re-run — already-encrypted values are skipped.
 *
 *   KOSH_ENCRYPTION_KEY=... DATABASE_URL=... pnpm db:encrypt
 *
 * Run this once after setting KOSH_ENCRYPTION_KEY on a database that already
 * holds plaintext rows. New writes are encrypted automatically.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { encryptSecret, encryptionEnabled, isEncrypted } from "./crypto";

const here = dirname(fileURLToPath(import.meta.url));
for (const p of [resolve(here, "../../../.env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(p)) loadEnv({ path: p, quiet: true });
}

/** Tables/columns that use `encryptedText` (keep in sync with the schema). */
const TARGETS: Record<string, string[]> = {
  accounts: ["account_number_mask", "upi_id", "notes"],
  transactions: ["notes", "narration", "counterparty_upi_id", "upi_reference", "utr_number"],
  bills: ["notes"],
};

async function main() {
  if (!encryptionEnabled()) {
    throw new Error("KOSH_ENCRYPTION_KEY is not set — nothing to encrypt.");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const pool = new Pool({ connectionString });
  let total = 0;
  for (const [table, cols] of Object.entries(TARGETS)) {
    for (const col of cols) {
      // identifiers come from the hardcoded map above, never user input
      const { rows } = await pool.query(
        `SELECT id, "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL`,
      );
      let n = 0;
      for (const row of rows) {
        if (isEncrypted(row.v)) continue;
        await pool.query(`UPDATE "${table}" SET "${col}" = $1 WHERE id = $2`, [
          encryptSecret(row.v),
          row.id,
        ]);
        n += 1;
        total += 1;
      }
      if (n > 0) console.log(`  ${table}.${col}: encrypted ${n} value(s)`);
    }
  }
  console.log(`Done. Encrypted ${total} value(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
