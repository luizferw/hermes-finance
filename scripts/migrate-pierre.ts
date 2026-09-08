import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { categorizePierreTransaction, PIERRE_CATEGORY_NAMES } from "./pierre-categorization";

type PierreAccount = {
  id: string;
  name?: string;
  type?: "BANK" | "CREDIT" | string;
  subtype?: string;
  currencyCode?: string;
  connectorName?: string;
  balance?: string | number;
  creditData?: { creditLimit?: string | number } | null;
};

type PierreTransaction = {
  id: string;
  account_id: string;
  amount: string | number;
  date: string;
  description?: string;
  original_description?: string;
  merchant?: string;
  type?: string;
  operation_type?: string | null;
  operationType?: string | null;
  status?: string;
};

type Source = { data: unknown[] };
type PlannedTransaction = {
  source: PierreTransaction;
  accountId: string;
  type: "income" | "expense" | "transfer" | "adjustment";
  amountMinor: number;
  transferAccountId?: string;
  settlementForCardTransactionId?: string;
};

const API_BASE = "https://www.pierre.finance/tools/api";
const USER_EMAIL = process.env.HERMES_FINANCE_USER_EMAIL ?? "luizfernandowitt00@gmail.com";
const apply = process.argv.includes("--apply");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function minor(value: string | number | undefined): number {
  const source = String(value ?? "").trim();
  const match = source.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Invalid money value from Pierre: ${source}`);
  const cents = Number((match[3] ?? "").padEnd(2, "0"));
  const result = Number(match[2]) * 100 + cents;
  if (!Number.isSafeInteger(result)) throw new Error(`Money value exceeds safe integer range: ${source}`);
  return match[1] === "-" ? -result : result;
}

function sourceDate(value: string): string {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid transaction date: ${value}`);
  return date;
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(sourceDate(a)) - Date.parse(sourceDate(b))) / 86_400_000);
}

function description(tx: PierreTransaction): string {
  const value = (tx.original_description ?? tx.description ?? tx.merchant ?? `Pierre ${tx.id}`).trim();
  return value.slice(0, 300) || `Pierre ${tx.id}`;
}

function importHash(accountId: string, transaction: PierreTransaction, amountMinor: number, descriptionValue: string): string {
  return createHash("sha256")
    .update(`${accountId}\u0000${transaction.id}\u0000${sourceDate(transaction.date)}\u0000${amountMinor}\u0000${descriptionValue}`)
    .digest("hex");
}

async function pierre<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${requireEnv("PIERRE_API_KEY")}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Pierre ${path} failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function sourceOperation(tx: PierreTransaction): string | null {
  return tx.operation_type ?? tx.operationType ?? null;
}

function matchCardPayments(
  accounts: PierreAccount[],
  transactions: PierreTransaction[],
): Map<string, string> {
  const kind = new Map(accounts.map((account) => [account.id, account.type]));
  const cardPayments = transactions
    .filter((tx) => kind.get(tx.account_id) === "CREDIT" && minor(tx.amount) < 0 && sourceOperation(tx) !== "ESTORNO")
    .sort((a, b) => sourceDate(a.date).localeCompare(sourceDate(b.date)) || a.id.localeCompare(b.id));
  const bankDebits = transactions.filter((tx) => kind.get(tx.account_id) === "BANK" && minor(tx.amount) < 0);
  const matchedBankIds = new Set<string>();
  const result = new Map<string, string>();

  for (const payment of cardPayments) {
    const candidates = bankDebits.filter(
      (bank) =>
        !matchedBankIds.has(bank.id) &&
        Math.abs(minor(bank.amount)) === Math.abs(minor(payment.amount)) &&
        daysBetween(bank.date, payment.date) <= 7,
    );
    // Linking an uncertain cash movement invents a transfer. Only a unique match is safe.
    if (candidates.length === 1) {
      result.set(payment.id, candidates[0]!.id);
      matchedBankIds.add(candidates[0]!.id);
    }
  }
  return result;
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const [accountsResponse, transactionsResponse] = await Promise.all([
    pierre<Source>("get-accounts"),
    pierre<Source>("get-transactions?startDate=2000-01-01&endDate=2026-09-08&format=raw"),
  ]);
  const sourceAccounts = accountsResponse.data as PierreAccount[];
  const sourceTransactions = transactionsResponse.data as PierreTransaction[];
  if (sourceAccounts.length === 0 || sourceTransactions.length === 0) throw new Error("Pierre returned no accounts or transactions");
  if (new Set(sourceAccounts.map((a) => a.id)).size !== sourceAccounts.length) throw new Error("Pierre returned duplicate account IDs");

  const sourceById = new Map(sourceAccounts.map((account) => [account.id, account]));
  for (const tx of sourceTransactions) {
    if (!sourceById.has(tx.account_id)) throw new Error(`Transaction ${tx.id} references an unknown source account`);
    minor(tx.amount);
    sourceDate(tx.date);
  }

  const transferPairs = matchCardPayments(sourceAccounts, sourceTransactions);
  const cardPaymentByBankId = new Map([...transferPairs.entries()].map(([cardTxId, bankTxId]) => [bankTxId, cardTxId]));
  const targetAccountIdBySourceId = new Map(sourceAccounts.map((account) => [account.id, randomUUID()]));
  const planned: PlannedTransaction[] = [];

  for (const tx of sourceTransactions) {
    const sourceAccount = sourceById.get(tx.account_id)!;
    const accountId = targetAccountIdBySourceId.get(tx.account_id)!;
    const sourceMinor = minor(tx.amount);
    const linkedCardPaymentId = cardPaymentByBankId.get(tx.id);
    if (linkedCardPaymentId) {
      const cardTx = sourceTransactions.find((candidate) => candidate.id === linkedCardPaymentId)!;
      planned.push({
        source: tx,
        accountId,
        type: "transfer",
        amountMinor: sourceMinor,
        transferAccountId: targetAccountIdBySourceId.get(cardTx.account_id)!,
      });
      continue;
    }
    if (sourceAccount.type === "BANK") {
      planned.push({ source: tx, accountId, type: sourceMinor >= 0 ? "income" : "expense", amountMinor: sourceMinor });
      continue;
    }
    // Pierre card debits increase debt. Hermes keeps card debt negative, so invert signs.
    const normalized = -sourceMinor;
    const linkedBankId = transferPairs.get(tx.id);
    if (linkedBankId) {
      // The bank-side transfer carries the canonical settlement; this source row is preserved as provenance below.
      continue;
    }
    const isRefund = sourceOperation(tx) === "ESTORNO";
    planned.push({
      source: tx,
      accountId,
      type: sourceMinor >= 0 ? "expense" : isRefund ? "income" : "adjustment",
      amountMinor: normalized,
    });
  }

  const contributions = new Map<string, number>(sourceAccounts.map((account) => [account.id, 0]));
  for (const transaction of planned) {
    const sourceId = sourceAccounts.find((account) => targetAccountIdBySourceId.get(account.id) === transaction.accountId)!.id;
    contributions.set(sourceId, contributions.get(sourceId)! + transaction.amountMinor);
    if (transaction.transferAccountId) {
      const destinationSourceId = sourceAccounts.find((account) => targetAccountIdBySourceId.get(account.id) === transaction.transferAccountId)!.id;
      contributions.set(destinationSourceId, contributions.get(destinationSourceId)! - transaction.amountMinor);
    }
  }

  const client = new Client({ connectionString: databaseUrl });
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
    const missingCategories = PIERRE_CATEGORY_NAMES.filter((name) => !categoryIdByName.has(name));
    if (missingCategories.length > 0) throw new Error(`Missing required categories: ${missingCategories.join(", ")}`);
    const existing = await client.query<{ accounts: string; transactions: string; imports: string }>(
      `SELECT
        (SELECT count(*) FROM accounts WHERE user_id = $1)::text AS accounts,
        (SELECT count(*) FROM transactions WHERE user_id = $1 AND deleted_at IS NULL)::text AS transactions,
        (SELECT count(*) FROM import_files WHERE user_id = $1)::text AS imports`,
      [userId],
    );
    if (existing.rows[0]!.accounts !== "0" || existing.rows[0]!.transactions !== "0" || existing.rows[0]!.imports !== "0") {
      throw new Error("Target user is not empty; refusing to mix or duplicate a Pierre migration");
    }

    const summary = {
      mode: apply ? "apply" : "dry-run",
      sourceAccounts: sourceAccounts.length,
      sourceTransactions: sourceTransactions.length,
      importedLedgerTransactions: planned.length,
      linkedCardPayments: transferPairs.size,
      unmatchedOrAmbiguousCardPayments: sourceTransactions.filter(
        (tx) => sourceById.get(tx.account_id)!.type === "CREDIT" && minor(tx.amount) < 0 && sourceOperation(tx) !== "ESTORNO" && !transferPairs.has(tx.id),
      ).length,
    };
    if (!apply) {
      console.log(JSON.stringify(summary));
      return;
    }

    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO user_settings (user_id, country, currency_code, locale, date_format, financial_year_start_month)
         VALUES ($1, 'BR', 'BRL', 'pt-BR', 'dd/MM/yyyy', 1)
         ON CONFLICT (user_id) DO UPDATE SET country = EXCLUDED.country, currency_code = EXCLUDED.currency_code,
           locale = EXCLUDED.locale, date_format = EXCLUDED.date_format, financial_year_start_month = EXCLUDED.financial_year_start_month`,
        [userId],
      );

      const importFileBySourceId = new Map<string, string>();
      for (const source of sourceAccounts) {
        const targetId = targetAccountIdBySourceId.get(source.id)!;
        const desiredBalance = source.type === "CREDIT" ? -minor(source.balance) : minor(source.balance);
        const openingBalance = desiredBalance - contributions.get(source.id)!;
        const earliest = sourceTransactions.filter((tx) => tx.account_id === source.id).map((tx) => sourceDate(tx.date)).sort()[0] ?? "2026-09-08";
        const type = source.type === "CREDIT" ? "credit_card" : "asset";
        const limit = source.type === "CREDIT" && source.creditData?.creditLimit !== undefined ? minor(source.creditData.creditLimit) : null;
        await client.query(
          `INSERT INTO accounts (id, user_id, name, type, currency_code, institution, opening_balance_minor, opening_balance_date, current_balance_minor, limit_minor, include_in_net_worth)
           VALUES ($1, $2, $3, $4, 'BRL', $5, $6, $7, $8, $9, true)`,
          [targetId, userId, source.name?.trim() || "Conta Pierre", type, source.connectorName ?? null, openingBalance, earliest, desiredBalance, limit],
        );
        await client.query(
          `INSERT INTO account_balances (account_id, date, balance_minor, currency_code) VALUES ($1, '2026-09-08', $2, 'BRL')`,
          [targetId, desiredBalance],
        );
        const fileId = randomUUID();
        importFileBySourceId.set(source.id, fileId);
        await client.query(
          `INSERT INTO import_files (id, user_id, account_id, file_name, status, row_count, columns, mapping, date_format, committed_at)
           VALUES ($1, $2, $3, $4, 'committed', $5, $6::jsonb, $7::jsonb, 'yyyy-MM-dd', now())`,
          [fileId, userId, targetId, `pierre-${source.name?.trim() || source.id}-2026-09-08.json`, sourceTransactions.filter((tx) => tx.account_id === source.id).length,
            JSON.stringify(["date", "amount", "description", "externalId", "operationType"]), JSON.stringify({ date: "date", amount: "amount", description: "description", externalId: "externalId" })],
        );
      }

      const txIdBySourceId = new Map<string, string>();
      for (const item of planned) {
        const txId = randomUUID();
        txIdBySourceId.set(item.source.id, txId);
        const value = description(item.source);
        const categoryId = categoryIdByName.get(categorizePierreTransaction({
          type: item.type,
          description: value,
          merchant: item.source.merchant,
          rawDescription: value,
        }))!;
        await client.query(
          `INSERT INTO transactions (id, user_id, account_id, transfer_account_id, type, status, date, amount_minor, currency_code, description, merchant, raw_description, category_id, external_id, import_hash, import_file_id)
           VALUES ($1, $2, $3, $4, $5, 'posted', $6, $7, 'BRL', $8, $9, $10, $11, $12, $13, $14)`,
          [txId, userId, item.accountId, item.transferAccountId ?? null, item.type, sourceDate(item.source.date), item.amountMinor, value,
            typeof item.source.merchant === "string" ? item.source.merchant.slice(0, 150) : null, value, categoryId, `pierre:${item.source.id}`, importHash(item.accountId, item.source, item.amountMinor, value), importFileBySourceId.get(item.source.account_id)!],
        );
        await client.query(
          `INSERT INTO transaction_splits (transaction_id, category_id, amount_minor, sort_order) VALUES ($1, $2, $3, 0)`,
          [txId, categoryId, item.amountMinor],
        );
      }

      for (const source of sourceTransactions) {
        const sourceAccount = sourceById.get(source.account_id)!;
        const sourceType = sourceAccount.type;
        const linkedBankId = transferPairs.get(source.id);
        const transactionId = txIdBySourceId.get(source.id) ?? (linkedBankId ? txIdBySourceId.get(linkedBankId) : undefined);
        if (!transactionId) throw new Error(`No ledger transaction for source transaction ${source.id}`);
        const parsedAmount = sourceType === "CREDIT" ? -minor(source.amount) : minor(source.amount);
        await client.query(
          `INSERT INTO import_rows (id, import_file_id, row_index, raw, status, parsed_date, parsed_amount_minor, parsed_description, parsed_external_id, transaction_id)
           VALUES ($1, $2, $3, $4::jsonb, 'approved', $5, $6, $7, $8, $9)`,
          [randomUUID(), importFileBySourceId.get(source.account_id)!, sourceTransactions.filter((candidate) => candidate.account_id === source.account_id).indexOf(source),
            JSON.stringify({ date: sourceDate(source.date), amount: String(source.amount), description: description(source), externalId: `pierre:${source.id}`, operationType: sourceOperation(source) }),
            sourceDate(source.date), parsedAmount, description(source), `pierre:${source.id}`, transactionId],
        );
      }

      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, data) VALUES ($1, 'import.pierre_migrated', 'migration', $2::jsonb)`,
        [userId, JSON.stringify(summary)],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify(summary));
    } catch (error) {
      await client.query("ROLLBACK");
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
