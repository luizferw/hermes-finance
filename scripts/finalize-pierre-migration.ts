import "dotenv/config";
import { Client } from "pg";
import { categorizePierreTransaction, PIERRE_CATEGORY_NAMES } from "./pierre-categorization";

const USER_EMAIL = process.env.HERMES_FINANCE_USER_EMAIL ?? "luizfernandowitt00@gmail.com";
const apply = process.argv.includes("--apply");

type PierreTransaction = {
  id: string;
  type: string;
  description: string;
  merchant: string | null;
  rawDescription: string | null;
  categoryId: string | null;
  status: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const client = new Client({ connectionString: requireEnv("DATABASE_URL") });
  await client.connect();
  try {
    const user = await client.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [USER_EMAIL]);
    if (user.rowCount !== 1) throw new Error(`Expected exactly one target user for ${USER_EMAIL}`);
    const userId = user.rows[0]!.id;

    const categories = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM categories WHERE user_id = $1",
      [userId],
    );
    const categoryIdByName = new Map(categories.rows.map((category) => [category.name, category.id]));
    const missing = PIERRE_CATEGORY_NAMES.filter((name) => !categoryIdByName.has(name));
    if (missing.length > 0) throw new Error(`Missing required categories: ${missing.join(", ")}`);

    if (apply) await client.query("BEGIN");
    try {
      const transactions = await client.query<PierreTransaction>(
        `SELECT id, type::text, description, merchant, raw_description AS "rawDescription", category_id AS "categoryId", status::text
         FROM transactions
         WHERE user_id = $1 AND deleted_at IS NULL AND external_id LIKE 'pierre:%'
           AND (status IN ('pending', 'imported') OR category_id IS NULL)
         ORDER BY date, id ${apply ? "FOR UPDATE" : ""}`,
        [userId],
      );
      if (transactions.rowCount === 0) throw new Error("No pending or uncategorized Pierre transactions found for target user");

      const planned = transactions.rows.map((transaction) => ({
        ...transaction,
        categoryId: transaction.categoryId ?? categoryIdByName.get(categorizePierreTransaction(transaction))!,
      }));
      const summary = Object.fromEntries(
        PIERRE_CATEGORY_NAMES.map((category) => [category, planned.filter((transaction) => transaction.categoryId === categoryIdByName.get(category)).length]),
      );
      if (planned.some((transaction) => !transaction.categoryId)) throw new Error("A transaction did not receive a valid category");

      if (!apply) {
        console.log(JSON.stringify({ mode: "dry-run", transactionCount: planned.length, categoryCounts: summary, statusAfterApply: "posted" }, null, 2));
        return;
      }

      for (const transaction of planned) {
        await client.query(
          `UPDATE transactions
           SET category_id = COALESCE(category_id, $1), status = 'posted'
           WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
             AND (status IN ('pending', 'imported') OR category_id IS NULL)`,
          [transaction.categoryId, transaction.id, userId],
        );
        await client.query(
          `UPDATE transaction_splits
           SET category_id = $1
           WHERE transaction_id = $2 AND category_id IS NULL`,
          [transaction.categoryId, transaction.id],
        );
      }
      const incomplete = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM transactions
         WHERE user_id = $1 AND deleted_at IS NULL AND external_id LIKE 'pierre:%'
           AND (category_id IS NULL OR status IN ('pending', 'imported'))`,
        [userId],
      );
      if (incomplete.rows[0]!.count !== "0") throw new Error("Pierre finalization post-condition failed");
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, data)
         VALUES ($1, 'import.pierre_finalized', 'migration', $2::jsonb)`,
        [userId, JSON.stringify({ transactionCount: planned.length, categoryCounts: summary, status: "posted" })],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ mode: "applied", transactionCount: planned.length, categoryCounts: summary, statusAfterApply: "posted" }, null, 2));
    } catch (error) {
      if (apply) await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
