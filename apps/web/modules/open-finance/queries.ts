import "server-only";
import { and, desc, eq } from "drizzle-orm";
import {
  accounts,
  db,
  openFinanceAccountLinks,
  openFinanceConnections,
  openFinanceSyncRuns,
} from "@kosh/db";
import { env } from "@/lib/env";

export type ConnectionRow = typeof openFinanceConnections.$inferSelect;
export type AccountLinkRow = typeof openFinanceAccountLinks.$inferSelect;
export type SyncRunRow = typeof openFinanceSyncRuns.$inferSelect;

export interface ConnectionView extends ConnectionRow {
  links: (AccountLinkRow & { accountName: string | null })[];
  lastRun: SyncRunRow | null;
  /** Whole days since the provider last reached the institution, or null. */
  dataAgeDays: number | null;
  consentExpired: boolean;
}

export function isOpenFinanceEnabled(): boolean {
  const config = env();
  return config.PLUGGY_ENABLED && Boolean(config.PLUGGY_CLIENT_ID && config.PLUGGY_CLIENT_SECRET);
}

/**
 * Every connection of one user with enough context to render the settings page.
 *
 * The account name is joined in because a link is meaningless to a person
 * without it: "vinculado a «Nubank Conta»" is a decision they can check, a uuid
 * is not.
 */
export async function listConnections(userId: string): Promise<ConnectionView[]> {
  const connections = await db.query.openFinanceConnections.findMany({
    where: eq(openFinanceConnections.userId, userId),
    orderBy: [desc(openFinanceConnections.createdAt)],
  });
  if (connections.length === 0) return [];

  const links = await db
    .select({
      link: openFinanceAccountLinks,
      accountName: accounts.name,
    })
    .from(openFinanceAccountLinks)
    .leftJoin(accounts, eq(accounts.id, openFinanceAccountLinks.accountId))
    .where(eq(openFinanceAccountLinks.userId, userId));

  const runs = await db.query.openFinanceSyncRuns.findMany({
    where: eq(openFinanceSyncRuns.userId, userId),
    orderBy: [desc(openFinanceSyncRuns.startedAt)],
    limit: 200,
  });

  const now = Date.now();
  return connections.map((connection) => ({
    ...connection,
    links: links
      .filter((row) => row.link.connectionId === connection.id)
      .map((row) => ({ ...row.link, accountName: row.accountName }))
      .sort((left, right) => (left.providerName ?? "").localeCompare(right.providerName ?? "")),
    lastRun: runs.find((run) => run.connectionId === connection.id) ?? null,
    dataAgeDays: connection.providerLastUpdatedAt
      ? Math.floor((now - connection.providerLastUpdatedAt.getTime()) / 86_400_000)
      : null,
    consentExpired: connection.consentExpiresAt
      ? connection.consentExpiresAt.getTime() <= now
      : false,
  }));
}

export async function getConnection(
  userId: string,
  connectionId: string,
): Promise<ConnectionRow | undefined> {
  return db.query.openFinanceConnections.findFirst({
    where: and(
      eq(openFinanceConnections.id, connectionId),
      eq(openFinanceConnections.userId, userId),
    ),
  });
}

export async function listSyncRuns(userId: string, limit = 20): Promise<SyncRunRow[]> {
  return db.query.openFinanceSyncRuns.findMany({
    where: eq(openFinanceSyncRuns.userId, userId),
    orderBy: [desc(openFinanceSyncRuns.startedAt)],
    limit,
  });
}

/** The user's accounts, for the override control on a link decision. */
export async function listLinkTargets(userId: string) {
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      currencyCode: accounts.currencyCode,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.isArchived, false)))
    .orderBy(accounts.name);
}
