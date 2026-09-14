import "server-only";
import { and, between, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  db,
  openFinanceAccountLinks,
  openFinanceConnections,
  creditCards,
  openFinanceSyncRuns,
  transactionMetadata,
  transactionSplits,
  transactions,
  type OpenFinanceSyncStats,
} from "@kosh/db";
import {
  accountKindOf,
  brazilianCalendarDay,
  normalizeAccount,
  normalizeBill,
  normalizeTransaction,
  PluggyError,
  type NormalizedAccount,
  type NormalizedBill,
  type NormalizedTransaction,
  type PluggyClient,
  type PluggyItem,
} from "@hermes-finance/open-finance";
import { computeImportHash, findDuplicate } from "@kosh/domain";
import { recomputeAccountBalances } from "@/modules/accounts/queries";
import { runRulesOnTransactions } from "@/modules/rules/engine";
import { logAudit } from "@/modules/shared/audit";
import { env } from "@/lib/env";
import { getPluggyClient, normalizeContext } from "./provider";
import { resolveAccountLink } from "./link";
import {
  ensureCreditCard,
  flagUnreconciledCycles,
  registerSyncedPurchase,
  syncBills,
} from "./cards";
import type { Trx } from "./types";
import type { SyncTrigger } from "./validators";

/**
 * How far back each run re-reads.
 *
 * Pluggy's own lookback is 4-5 days for direct connectors and 7 for regulated
 * Open Finance ones, because a transaction posted over a weekend can appear days
 * late. Re-reading the same window costs nothing — `(account_id, external_id)`
 * is unique, so a row already stored is recognised, not duplicated — and it is
 * what catches a late posting and a pending charge that has since settled.
 */
const REWINDOW_DAYS = 8;

/** A run still marked `running` after this long crashed; another may claim it. */
const STALE_CLAIM_MINUTES = 30;

/** Item states where there is nothing to fetch and the user has to act. */
const BLOCKING_ITEM_STATUSES = new Set([
  "LOGIN_ERROR",
  "WAITING_USER_INPUT",
  "WAITING_USER_ACTION",
  "OUTDATED_CREDENTIALS",
]);

export interface SyncCounts {
  seen: number;
  created: number;
  updated: number;
  duplicates: number;
  needsReview: number;
  skipped: number;
}

export interface SyncRunSummary {
  runId: string | null;
  connectionId: string;
  status: "ok" | "partial" | "error" | "skipped";
  counts: SyncCounts;
  message: string | null;
}

export interface SyncOptions {
  trigger: SyncTrigger;
  /** Injected by tests. Production resolves the client from the environment. */
  client?: PluggyClient;
  now?: () => Date;
}

function emptyCounts(): SyncCounts {
  return { seen: 0, created: 0, updated: 0, duplicates: 0, needsReview: 0, skipped: 0 };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysIso(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

/**
 * Sync one connection.
 *
 * Session-free by design: the scheduled job has no HTTP session, and the server
 * action passes the user id it already resolved. Nothing here reads a session or
 * revalidates a path — that belongs to `mutations.ts`.
 */
export async function syncConnection(
  userId: string,
  connectionId: string,
  options: SyncOptions,
): Promise<SyncRunSummary> {
  const now = options.now ?? (() => new Date());
  const client = options.client ?? getPluggyClient();
  const counts = emptyCounts();

  if (!client) {
    return {
      runId: null,
      connectionId,
      status: "skipped",
      counts,
      message: "Open Finance is switched off on this installation (PLUGGY_ENABLED=false).",
    };
  }

  const connection = await db.query.openFinanceConnections.findFirst({
    where: and(
      eq(openFinanceConnections.id, connectionId),
      eq(openFinanceConnections.userId, userId),
    ),
  });
  if (!connection) {
    return { runId: null, connectionId, status: "error", counts, message: "Connection not found." };
  }

  // Claim the connection so a manual sync and the scheduled job cannot both walk
  // the same accounts. The stale escape stops a crashed run wedging it forever.
  const staleBefore = new Date(now().getTime() - STALE_CLAIM_MINUTES * 60_000);
  const [claimed] = await db
    .update(openFinanceConnections)
    .set({ lastSyncStatus: "running" })
    .where(
      and(
        eq(openFinanceConnections.id, connectionId),
        eq(openFinanceConnections.userId, userId),
        or(
          sql`${openFinanceConnections.lastSyncStatus} IS DISTINCT FROM 'running'`,
          lt(openFinanceConnections.lastSyncedAt, staleBefore),
          isNull(openFinanceConnections.lastSyncedAt),
        ),
      ),
    )
    .returning({ id: openFinanceConnections.id });

  if (!claimed) {
    return {
      runId: null,
      connectionId,
      status: "skipped",
      counts,
      message: "A sync of this connection is already running.",
    };
  }

  const [run] = await db
    .insert(openFinanceSyncRuns)
    .values({
      userId,
      connectionId,
      trigger: options.trigger,
      institution: connection.connectorName,
      startedAt: now(),
    })
    .returning({ id: openFinanceSyncRuns.id });
  const runId = run!.id;

  const stats: OpenFinanceSyncStats = {};
  let status: SyncRunSummary["status"] = "ok";
  let message: string | null = null;
  const createdIds: string[] = [];

  try {
    const item = await client.getItem(connection.itemId);
    await db
      .update(openFinanceConnections)
      .set({
        status: item.status ?? "unknown",
        executionStatus: item.executionStatus,
        connectorId: item.connector?.id ?? connection.connectorId,
        connectorName: item.connector?.name ?? connection.connectorName,
        connectorImageUrl: item.connector?.imageUrl ?? connection.connectorImageUrl,
        providerLastUpdatedAt: item.lastUpdatedAt ? new Date(item.lastUpdatedAt) : null,
        consentExpiresAt: item.consentExpiresAt ? new Date(item.consentExpiresAt) : null,
      })
      .where(eq(openFinanceConnections.id, connectionId));

    const blocked = blockingReason(item, now());
    if (blocked) {
      // Nothing is written to the ledger in this state. Empty data endpoints on a
      // revoked consent would otherwise read as "everything was deleted".
      throw new SyncBlocked(blocked);
    }

    const observedAt = brazilianCalendarDay(
      item.lastUpdatedAt ?? now().toISOString(),
      env().PLUGGY_TIMEZONE_OFFSET_MINUTES,
    );

    const providerAccounts = await client.listAccounts(connection.itemId);
    const context = normalizeContext();
    const touched: string[] = [];

    for (const raw of providerAccounts) {
      const incoming = normalizeAccount(raw, context);
      const kind = accountKindOf(raw);

      const resolved = await db.transaction((trx) =>
        resolveAccountLink(trx, userId, connection, incoming),
      );
      if (resolved.needsReview) counts.needsReview += 1;
      if (!resolved.accountId) {
        counts.skipped += 1;
        stats.unsupportedAccounts = (stats.unsupportedAccounts ?? 0) + 1;
        continue;
      }

      try {
        const accountCounts = await syncAccount({
          client,
          userId,
          accountId: resolved.accountId,
          linkId: resolved.linkId,
          providerAccountId: incoming.externalId,
          kind,
          account: incoming,
          providerBalanceMinor: incoming.balanceMinor,
          observedAt,
          // Not `createdAccount`: an account created by a run that then failed
          // mid-way would never get its opening balance solved, because the
          // next run finds the link already there. `openingBalanceDerivedAt` is
          // the real once-only guard, and it is checked inside.
          derivedOpeningBalance: resolved.mode === "auto_created",
          now: now(),
          stats,
          createdIds,
        });
        mergeCounts(counts, accountCounts);
        touched.push(resolved.accountId);
      } catch (error) {
        status = "partial";
        stats.failedAccounts = [
          ...(stats.failedAccounts ?? []),
          { providerAccountId: incoming.externalId, error: errorName(error) },
        ];
      }
    }

    if (touched.length > 0) await recomputeAccountBalances(touched);
  } catch (error) {
    status = "error";
    message = failureMessage(error);
  }

  await db
    .update(openFinanceSyncRuns)
    .set({
      completedAt: now(),
      status,
      recordsSeen: counts.seen,
      recordsCreated: counts.created,
      recordsUpdated: counts.updated,
      duplicates: counts.duplicates,
      needsReview: counts.needsReview,
      skipped: counts.skipped,
      error: message,
      stats,
    })
    .where(eq(openFinanceSyncRuns.id, runId));

  await db
    .update(openFinanceConnections)
    .set({ lastSyncedAt: now(), lastSyncStatus: status, lastSyncError: message })
    .where(eq(openFinanceConnections.id, connectionId));

  // Rules run outside every write transaction, exactly as commitImport does, so
  // a slow rule cannot hold a lock on the ledger.
  if (createdIds.length > 0) {
    await runRulesOnTransactions(userId, createdIds, "import");
  }

  await logAudit({
    userId,
    action: "open_finance.synced",
    entityType: "open_finance_connection",
    entityId: connectionId,
    data: { status, trigger: options.trigger, ...counts },
  });

  return { runId, connectionId, status, counts, message };
}

/** What to show the user, without leaking a provider message into the UI. */
function failureMessage(error: unknown): string {
  if (error instanceof SyncBlocked) return error.message;
  if (error instanceof PluggyError) {
    return `Pluggy answered ${error.status} (${error.code}).`;
  }
  return "The sync failed.";
}

class SyncBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncBlocked";
  }
}

/**
 * Why this item cannot be synced right now, in words the user can act on.
 *
 * Every remedy happens at meu.pluggy.ai, never here: Hermes has no consent flow
 * and never sends credentials.
 */
function blockingReason(item: PluggyItem, now: Date): string | null {
  const status = item.status?.toUpperCase() ?? "";
  if (BLOCKING_ITEM_STATUSES.has(status)) {
    return "This connection has to be re-established at meu.pluggy.ai before it can sync again.";
  }
  if (item.consentExpiresAt && new Date(item.consentExpiresAt) <= now) {
    return "The consent has expired. Renew the connection at meu.pluggy.ai.";
  }
  if (status === "UPDATING" || status === "CREATING") {
    return "Pluggy is still updating this connection. Try again in a few minutes.";
  }
  return null;
}

/**
 * What to record about a failure.
 *
 * The name alone is what `system_jobs` stores, and it proved useless here: every
 * account failed as "PluggyError" and finding out why took a round trip to the
 * API. The status and Pluggy's own error code are safe to keep — they describe
 * the request, not the account holder — while the message still never lands in
 * the database.
 */
function errorName(error: unknown): string {
  if (error instanceof PluggyError) return `PluggyError(${error.status}/${error.code})`;
  return error instanceof Error ? error.name : "UnknownError";
}

function mergeCounts(into: SyncCounts, from: SyncCounts): void {
  into.seen += from.seen;
  into.created += from.created;
  into.updated += from.updated;
  into.duplicates += from.duplicates;
  into.needsReview += from.needsReview;
  into.skipped += from.skipped;
}

interface SyncAccountArgs {
  client: PluggyClient;
  userId: string;
  accountId: string;
  linkId: string;
  providerAccountId: string;
  kind: "bank" | "credit";
  account: NormalizedAccount;
  providerBalanceMinor: number;
  observedAt: string;
  derivedOpeningBalance: boolean;
  now: Date;
  stats: OpenFinanceSyncStats;
  createdIds: string[];
}

/** Fetch, normalize and store one account's transactions, then its balance. */
async function syncAccount(args: SyncAccountArgs): Promise<SyncCounts> {
  const counts = emptyCounts();
  const context = normalizeContext();
  const config = env();

  const link = await db.query.openFinanceAccountLinks.findFirst({
    where: eq(openFinanceAccountLinks.id, args.linkId),
  });
  const today = isoDay(args.now);
  const from = link?.syncedThrough
    ? addDaysIso(link.syncedThrough, -REWINDOW_DAYS)
    : addDaysIso(today, -config.PLUGGY_BACKFILL_DAYS);

  const raw = await args.client.listTransactions(args.providerAccountId, {
    dateFrom: from,
    dateTo: today,
  });
  counts.seen = raw.length;

  // Bills are only fetched for cards, and only from connectors that carry the
  // product. An institution that does not publish them simply returns nothing,
  // which is not an error — the ledger-derived cycles still cover that card.
  let bills: NormalizedBill[] = [];
  if (args.kind === "credit") {
    try {
      const rawBills = await args.client.listBills(args.providerAccountId);
      bills = rawBills.map((bill) => normalizeBill(bill, context));
    } catch {
      bills = [];
    }
  }

  const rows: NormalizedTransaction[] = [];
  for (const entry of raw) {
    const normalized = normalizeTransaction(entry, args.kind, context);
    if (normalized.kind === "skipped") {
      counts.skipped += 1;
      if (normalized.reason === "card_payment_leg") {
        args.stats.skippedCardPayments = (args.stats.skippedCardPayments ?? 0) + 1;
      } else {
        args.stats.skippedZeroAmount = (args.stats.skippedZeroAmount ?? 0) + 1;
      }
      continue;
    }
    rows.push(normalized);
  }

  await db.transaction(async (trx) => {
    const existing = await loadExistingWindow(trx, args.accountId, rows);
    const knownExternalIds = new Set(
      existing.map((row) => row.externalId).filter((id): id is string => id !== null),
    );

    for (const row of rows) {
      const isNew = !knownExternalIds.has(row.externalId);
      const importHash = computeImportHash({
        accountId: args.accountId,
        date: row.date,
        amountMinor: row.amountMinor,
        description: row.description,
      });

      // A row Pluggy has not sent before may still be one the user imported by
      // hand from a CSV. §26 says an uncertain match is flagged, never dropped.
      let suspectedDuplicateOfId: string | null = null;
      if (isNew) {
        const duplicate = findDuplicate(
          args.accountId,
          {
            date: row.date,
            amountMinor: row.amountMinor,
            description: row.description,
            externalId: row.externalId,
          },
          existing,
        );
        if (duplicate) {
          suspectedDuplicateOfId = duplicate.transactionId;
          counts.duplicates += 1;
          counts.needsReview += 1;
        }
      }

      const [written] = await trx
        .insert(transactions)
        .values({
          userId: args.userId,
          accountId: args.accountId,
          type: row.type,
          // A flagged duplicate stays out of the balance until a human rules on
          // it; `pending` is the only status recomputeAccountBalances ignores.
          status: suspectedDuplicateOfId ? "pending" : row.status,
          date: row.date,
          amountMinor: row.amountMinor,
          currencyCode: row.currencyCode,
          description: row.description,
          rawDescription: row.rawDescription ?? row.description,
          merchant: row.merchant,
          externalId: row.externalId,
          importHash,
          suspectedDuplicateOfId,
        })
        .onConflictDoUpdate({
          target: [transactions.accountId, transactions.externalId],
          targetWhere: sql`external_id IS NOT NULL AND deleted_at IS NULL`,
          set: {
            amountMinor: row.amountMinor,
            date: row.date,
            status: row.status,
            description: row.description,
            merchant: row.merchant,
            updatedAt: new Date(),
          },
          // Never overwrite work a human has done. Once a row has been reviewed
          // or posted, the provider no longer gets to rewrite its category,
          // amount or description.
          setWhere: sql`${transactions.status} in ('imported','pending')`,
        })
        .returning({ id: transactions.id });

      if (!written) {
        // The row exists and is reviewed or posted, so the upsert was declined.
        continue;
      }

      if (isNew) {
        counts.created += 1;
        args.createdIds.push(written.id);
        await trx
          .insert(transactionSplits)
          .values({ transactionId: written.id, amountMinor: row.amountMinor, sortOrder: 0 })
          .onConflictDoNothing();
      } else {
        counts.updated += 1;
      }

      await writeProviderMetadata(trx, written.id, row);
    }

    if (args.kind === "credit") {
      mergeCounts(counts, await syncCardSide(trx, args, bills, rows));
    }

    await recomputeAccountBalances([args.accountId], trx);

    if (args.derivedOpeningBalance && !link?.openingBalanceDerivedAt) {
      await deriveOpeningBalance(trx, args);
    }

    await trx
      .update(openFinanceAccountLinks)
      .set({
        syncedThrough: today,
        lastTransactionSyncedAt: args.now,
        providerBalanceMinor: args.providerBalanceMinor,
        providerBalanceObservedAt: args.now,
      })
      .where(eq(openFinanceAccountLinks.id, args.linkId));

    await trx
      .insert(balanceSnapshots)
      .values({
        userId: args.userId,
        accountId: args.accountId,
        amountMinor: args.providerBalanceMinor,
        // The provider's own timestamp, not ours. Reporting the sync time as the
        // observation time would claim a freshness the data does not have (R8).
        observedAt: args.observedAt,
        source: "pluggy",
      })
      .onConflictDoUpdate({
        target: [balanceSnapshots.accountId, balanceSnapshots.observedAt],
        set: { amountMinor: args.providerBalanceMinor, source: "pluggy" },
      });
  });

  return counts;
}

/**
 * The credit-card half of a sync: the card profile, its bills, its purchases and
 * its installment plans.
 *
 * A bill written with `confirmedTotalMinor` is what lifts the statement's
 * confidence from HIGH to CONFIRMED inside `projectStatements` — no change to
 * the forecast package is needed for that, which is exactly what PRD §51 asks
 * for.
 */
async function syncCardSide(
  trx: Trx,
  args: SyncAccountArgs,
  bills: readonly NormalizedBill[],
  rows: readonly NormalizedTransaction[],
): Promise<SyncCounts> {
  const counts = emptyCounts();

  const { creditCardId } = await ensureCreditCard(
    trx,
    args.userId,
    args.accountId,
    args.account,
    bills,
  );
  if (!creditCardId) {
    // Without a closing and a due day every installment date would be a guess,
    // so the card profile is not created and the gap is surfaced instead.
    counts.needsReview += 1;
    return counts;
  }

  const card = await trx.query.creditCards.findFirst({
    where: eq(creditCards.id, creditCardId),
  });
  if (!card) return counts;

  await trx
    .update(openFinanceAccountLinks)
    .set({ creditCardId })
    .where(eq(openFinanceAccountLinks.id, args.linkId));

  await syncBills(
    trx,
    creditCardId,
    card.defaultClosingDay,
    card.defaultDueDay,
    bills,
    isoDay(args.now),
  );

  for (const row of rows) {
    const [stored] = await trx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, args.accountId),
          eq(transactions.externalId, row.externalId),
          isNull(transactions.deletedAt),
        ),
      );
    if (!stored) continue;
    await registerSyncedPurchase(trx, {
      creditCardId,
      closingDay: card.defaultClosingDay,
      dueDay: card.defaultDueDay,
      transactionId: stored.id,
      row,
    });
  }

  counts.needsReview += await flagUnreconciledCycles(
    trx,
    creditCardId,
    card.defaultClosingDay,
    card.defaultDueDay,
    bills,
    rows,
  );

  return counts;
}

/**
 * Back-solve the opening balance so the ledger lands on the bank's number.
 *
 * An auto-created account starts empty and receives at most twelve months of
 * history, so the sum of what arrived is not the balance — the missing years
 * are. Rather than invent an adjustment transaction, the difference goes into
 * the opening balance, which is exactly what that column means. Runs once, on
 * the account's first sync, and never on an account the user already owned:
 * rewriting someone's own opening balance would silently rewrite their history.
 */
async function deriveOpeningBalance(trx: Trx, args: SyncAccountArgs): Promise<void> {
  const [account] = await trx
    .select({
      currentBalanceMinor: accounts.currentBalanceMinor,
      openingBalanceMinor: accounts.openingBalanceMinor,
    })
    .from(accounts)
    .where(eq(accounts.id, args.accountId));
  if (!account) return;

  const openingBalanceMinor =
    account.openingBalanceMinor + (args.providerBalanceMinor - account.currentBalanceMinor);

  const [earliest] = await trx
    .select({ date: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(and(eq(transactions.accountId, args.accountId), isNull(transactions.deletedAt)));

  await trx
    .update(accounts)
    .set({
      openingBalanceMinor,
      openingBalanceDate: earliest?.date ? addDaysIso(earliest.date, -1) : isoDay(args.now),
    })
    .where(eq(accounts.id, args.accountId));

  await recomputeAccountBalances([args.accountId], trx);

  await trx
    .update(openFinanceAccountLinks)
    .set({ openingBalanceDerivedAt: args.now })
    .where(eq(openFinanceAccountLinks.id, args.linkId));
}

/**
 * Existing rows near the incoming dates, for duplicate detection.
 *
 * Bounded to the window the batch actually covers, widened by the tolerance
 * `findDuplicate` uses for a near-date match, so an account with years of
 * history does not get read into memory on every sync.
 */
async function loadExistingWindow(
  trx: Trx,
  accountId: string,
  rows: readonly NormalizedTransaction[],
) {
  if (rows.length === 0) return [];
  const dates = rows.map((row) => row.date).sort();
  const from = addDaysIso(dates[0]!, -3);
  const to = addDaysIso(dates[dates.length - 1]!, 3);

  return trx
    .select({
      id: transactions.id,
      date: transactions.date,
      amountMinor: transactions.amountMinor,
      importHash: transactions.importHash,
      externalId: transactions.externalId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        isNull(transactions.deletedAt),
        between(transactions.date, from, to),
      ),
    );
}

/**
 * Provenance and hints, kept beside the transaction rather than inside it.
 *
 * The card-payment tag is the hook for a later phase: the bank-side debit of a
 * card bill is booked as an ordinary expense today, which PRD R4 says it should
 * not be, and tagging it now means that pair can be turned into a transfer
 * without re-fetching anything from the provider.
 */
async function writeProviderMetadata(
  trx: Trx,
  transactionId: string,
  row: NormalizedTransaction,
): Promise<void> {
  const entries: { key: string; value: string }[] = [
    { key: "open_finance.provider", value: "pluggy" },
  ];
  if (row.providerCategory) {
    entries.push({ key: "open_finance.category", value: row.providerCategory });
  }
  if (row.billExternalId) {
    entries.push({ key: "open_finance.bill_id", value: row.billExternalId });
  }
  if (row.installment) {
    entries.push({
      key: "open_finance.installment",
      value: `${row.installment.number}/${row.installment.total}`,
    });
  }
  if (row.cardPaymentCandidate) {
    entries.push({ key: "open_finance.card_payment_candidate", value: "true" });
  }

  await trx
    .insert(transactionMetadata)
    .values(entries.map((entry) => ({ transactionId, ...entry })))
    .onConflictDoUpdate({
      target: [transactionMetadata.transactionId, transactionMetadata.key],
      set: { value: sql`excluded.value` },
    });
}

/** Every active connection of one user. Used by the manual "sync all" path. */
export async function syncAllConnectionsForUser(
  userId: string,
  options: SyncOptions,
): Promise<SyncRunSummary[]> {
  const connections = await db.query.openFinanceConnections.findMany({
    where: and(
      eq(openFinanceConnections.userId, userId),
      eq(openFinanceConnections.isActive, true),
    ),
  });
  const summaries: SyncRunSummary[] = [];
  for (const connection of connections) {
    summaries.push(await syncConnection(userId, connection.id, options));
  }
  return summaries;
}

/**
 * Every active connection of every user — the scheduled job's entry point.
 *
 * Jobs in this app carry no payload and no user, so the fan-out happens here.
 * One user's broken connection must not stop the next user's sync, so each
 * connection is isolated.
 */
export async function syncAllConnections(
  options: SyncOptions,
): Promise<{ connections: number; ok: number; failed: number }> {
  const connections = await db
    .select({ id: openFinanceConnections.id, userId: openFinanceConnections.userId })
    .from(openFinanceConnections)
    .where(eq(openFinanceConnections.isActive, true));

  let ok = 0;
  let failed = 0;
  for (const connection of connections) {
    try {
      const summary = await syncConnection(connection.userId, connection.id, options);
      if (summary.status === "ok" || summary.status === "skipped") ok += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { connections: connections.length, ok, failed };
}

/** Transactions this sync flagged as possible duplicates, for the review inbox. */
export async function listFlaggedDuplicates(userId: string, since: Date) {
  return db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.createdAt, since),
        eq(transactions.status, "pending"),
        inArray(transactions.type, ["income", "expense"]),
      ),
    );
}
