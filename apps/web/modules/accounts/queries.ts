import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { accountBalances, accounts, db, transactions } from "@kosh/db";
import { addMonthsClamped, todayIso } from "@kosh/domain";
import { getUserSettings } from "@/modules/settings/queries";

export type AccountRow = typeof accounts.$inferSelect;

export async function listAccounts(userId: string): Promise<AccountRow[]> {
  return db.query.accounts.findMany({
    where: and(eq(accounts.userId, userId)),
    orderBy: [asc(accounts.isArchived), asc(accounts.type), asc(accounts.name)],
  });
}

export async function getAccount(
  userId: string,
  accountId: string,
): Promise<AccountRow | undefined> {
  return db.query.accounts.findFirst({
    where: and(eq(accounts.id, accountId), eq(accounts.userId, userId)),
  });
}

/** Balance snapshots for the trend chart (last `months` months). */
export async function getAccountBalanceHistory(
  userId: string,
  accountId: string,
  months = 4,
) {
  const account = await getAccount(userId, accountId);
  if (!account) return [];
  const since = addMonthsClamped(todayIso(), -months);
  return db.query.accountBalances.findMany({
    where: and(
      eq(accountBalances.accountId, accountId),
      gte(accountBalances.date, since),
    ),
    orderBy: [asc(accountBalances.date)],
  });
}

/** All users' snapshots since a date — powers net worth charts. */
export async function getBalanceSnapshots(userId: string, sinceIso: string) {
  const { currencyCode } = await getUserSettings(userId);
  const rows = await db
    .select({
      accountId: accountBalances.accountId,
      date: accountBalances.date,
      balanceMinor: accountBalances.balanceMinor,
    })
    .from(accountBalances)
    .innerJoin(accounts, eq(accountBalances.accountId, accounts.id))
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.currencyCode, currencyCode),
        eq(accounts.includeInNetWorth, true),
        gte(accountBalances.date, sinceIso),
      ),
    )
    .orderBy(asc(accountBalances.date));
  return rows;
}

export interface NetWorthSummary {
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  currencyCode: string;
}

type BalanceDatabase = Pick<typeof db, "execute" | "insert"> & {
  query: { accounts: Pick<typeof db.query.accounts, "findMany"> };
};

export async function getNetWorthSummary(
  userId: string,
): Promise<NetWorthSummary> {
  const { currencyCode } = await getUserSettings(userId);
  const rows = await db.query.accounts.findMany({
    where: and(
      eq(accounts.userId, userId),
      eq(accounts.currencyCode, currencyCode),
      eq(accounts.includeInNetWorth, true),
      eq(accounts.isArchived, false),
    ),
  });
  let assets = 0;
  let liabilities = 0;
  for (const account of rows) {
    if (account.currentBalanceMinor >= 0) assets += account.currentBalanceMinor;
    else liabilities += -account.currentBalanceMinor;
  }
  return {
    netWorthMinor: assets - liabilities,
    assetsMinor: assets,
    liabilitiesMinor: liabilities,
    currencyCode,
  };
}

/**
 * Recompute and cache the live balance for the given accounts from the
 * ledger (opening balance + signed amounts + incoming transfers).
 */
export async function recomputeAccountBalances(
  accountIds: string[],
  database: BalanceDatabase = db,
): Promise<void> {
  if (accountIds.length === 0) return;
  const ledger = sql`'imported','reviewed','posted'`;
  await database.execute(sql`
    UPDATE ${accounts} a
    SET current_balance_minor = a.opening_balance_minor
      + COALESCE((
          SELECT SUM(t.amount_minor) FROM ${transactions} t
          WHERE t.account_id = a.id
            AND t.status::text IN (${ledger})
            AND t.deleted_at IS NULL
        ), 0)
      + COALESCE((
          SELECT SUM(-t.amount_minor) FROM ${transactions} t
          WHERE t.transfer_account_id = a.id
            AND t.user_id = a.user_id
            AND t.type = 'transfer'
            AND t.status::text IN (${ledger})
            AND t.deleted_at IS NULL
        ), 0)
    WHERE a.id = ANY(${sql.param(accountIds)}::uuid[])
  `);

  // Refresh today's snapshot so charts stay truthful.
  const today = todayIso();
  const fresh = await database.query.accounts.findMany({
    where: inArray(accounts.id, accountIds),
  });
  for (const account of fresh) {
    await database
      .insert(accountBalances)
      .values({
        accountId: account.id,
        date: today,
        balanceMinor: account.currentBalanceMinor,
        currencyCode: account.currencyCode,
      })
      .onConflictDoUpdate({
        target: [accountBalances.accountId, accountBalances.date],
        set: { balanceMinor: account.currentBalanceMinor },
      });
  }
}

/** Recent transactions touching one account (including incoming transfers). */
export async function getAccountTransactions(
  userId: string,
  accountId: string,
  limit = 30,
) {
  return db.query.transactions.findMany({
    where: and(
      eq(transactions.userId, userId),
      isNull(transactions.deletedAt),
      sql`(${transactions.accountId} = ${accountId} OR ${transactions.transferAccountId} = ${accountId})`,
    ),
    with: { category: true, account: true, transferAccount: true },
    orderBy: [desc(transactions.date), desc(transactions.createdAt)],
    limit,
  });
}
