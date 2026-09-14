import "server-only";
import { and, between, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  categories,
  db,
  openFinanceAccountLinks,
  openFinanceCardPayments,
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
  matchCardPayments,
  providerCategoryName,
  TRANSFER_CATEGORY_NAME,
  normalizeAccount,
  normalizeBill,
  normalizeTransaction,
  PluggyError,
  type NormalizedAccount,
  type NormalizedBill,
  type CardPaymentLeg,
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

    // Pairing runs after every account of this connection has landed, and looks
    // across all of them: the card and the account that pays its bill are
    // frequently at different institutions, so the two legs arrive from
    // different connections and often on different days.
    const paired = await pairCardPayments(userId);
    counts.needsReview += paired.ambiguous;
    if (paired.matched > 0) stats.cardPaymentsPaired = paired.matched;

    // Balances are recomputed last, and after pairing on purpose: a payment that
    // has just become a transfer credits the card, and computing before it would
    // leave the card short by exactly the amount that was paid.
    const toRecompute = [...new Set([...touched, ...paired.touchedAccountIds])];
    if (toRecompute.length > 0) await recomputeAccountBalances(toRecompute);

    // Last of all, because everything above changes what the ledger contains.
    const corrected = await reconcileDerivedOpeningBalances(userId);
    if (corrected.length > 0) stats.openingBalanceCorrections = corrected;
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
  const paymentLegs: { providerTransactionId: string; paidAt: string; amountMinor: number }[] = [];
  for (const entry of raw) {
    const normalized = normalizeTransaction(entry, args.kind, context);
    if (normalized.kind === "skipped") {
      counts.skipped += 1;
      if (normalized.reason === "card_payment_leg") {
        args.stats.skippedCardPayments = (args.stats.skippedCardPayments ?? 0) + 1;
        paymentLegs.push({
          providerTransactionId: normalized.externalId,
          paidAt: normalized.date,
          amountMinor: normalized.amountMinor,
        });
      } else {
        args.stats.skippedZeroAmount = (args.stats.skippedZeroAmount ?? 0) + 1;
      }
      continue;
    }
    rows.push(normalized);
  }

  // Loaded once: the provider's category is a name here, and resolving it per
  // row would be a query per transaction.
  const categoryIds = new Map(
    (await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.userId, args.userId))).map((row) => [row.name, row.id]),
  );

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
          categoryId: resolveCategoryId(row, categoryIds, args.stats),
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
            // categoryId is deliberately absent. Re-reading a window must never
            // undo a category a rule or a person set afterwards.
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
      // The payment legs are remembered rather than booked. They are not
      // expenses of the card (PRD R4); they are the evidence that lets the
      // paying account's outflow be recognised as a transfer.
      if (paymentLegs.length > 0) {
        await trx
          .insert(openFinanceCardPayments)
          .values(
            paymentLegs.map((leg) => ({
              userId: args.userId,
              accountLinkId: args.linkId,
              accountId: args.accountId,
              ...leg,
            })),
          )
          .onConflictDoNothing({
            target: [
              openFinanceCardPayments.accountLinkId,
              openFinanceCardPayments.providerTransactionId,
            ],
          });
      }
      mergeCounts(counts, await syncCardSide(trx, args, bills, rows));
    }

    await recomputeAccountBalances([args.accountId], trx);

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

  // Oldest first, so parcel 1 is always seen before parcel 2. The provider
  // returns newest first, and in that order a later parcel creates the plan and
  // the earlier one cannot join it — every purchase then becomes several
  // overlapping plans, each projecting its own tail (PRD R3).
  for (const row of [...rows].sort((left, right) => left.date.localeCompare(right.date))) {
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
 * Keep an auto-created account's ledger landing on the balance the bank reports.
 *
 * These accounts start empty and receive at most twelve months of history, so
 * the sum of what arrived is never the balance — the years before the window
 * are. That difference belongs in the opening balance, which is exactly what
 * that column means, rather than in an invented adjustment transaction.
 *
 * It is re-solved on every sync rather than once. The first version solved it
 * once and that was wrong: anything which later changes what the window contains
 * — a late posting, a re-read, a bill payment that becomes a transfer — leaves
 * the old difference baked in and the account counts that money twice. The
 * provider states the true balance every run, so the correction is always
 * available; not applying it is the only way to drift.
 *
 * It never runs on an account the user already owned. Rewriting someone's own
 * opening balance would silently rewrite their history, so for those the
 * difference is reported as drift and left alone.
 */
async function reconcileDerivedOpeningBalances(
  userId: string,
): Promise<{ accountId: string; correctionMinor: number }[]> {
  const links = await db
    .select({
      accountId: openFinanceAccountLinks.accountId,
      linkId: openFinanceAccountLinks.id,
      providerBalanceMinor: openFinanceAccountLinks.providerBalanceMinor,
      derivedAt: openFinanceAccountLinks.openingBalanceDerivedAt,
    })
    .from(openFinanceAccountLinks)
    .where(
      and(
        eq(openFinanceAccountLinks.userId, userId),
        eq(openFinanceAccountLinks.linkMode, "auto_created"),
        isNotNull(openFinanceAccountLinks.accountId),
        isNotNull(openFinanceAccountLinks.providerBalanceMinor),
      ),
    );

  const corrections: { accountId: string; correctionMinor: number }[] = [];

  for (const link of links) {
    const accountId = link.accountId!;
    const [account] = await db
      .select({
        currentBalanceMinor: accounts.currentBalanceMinor,
        openingBalanceMinor: accounts.openingBalanceMinor,
        openingBalanceDate: accounts.openingBalanceDate,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    if (!account) continue;

    const correctionMinor = link.providerBalanceMinor! - account.currentBalanceMinor;
    if (correctionMinor === 0) continue;

    const [earliest] = await db
      .select({ date: sql<string | null>`min(${transactions.date})` })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), isNull(transactions.deletedAt)));

    await db
      .update(accounts)
      .set({
        openingBalanceMinor: account.openingBalanceMinor + correctionMinor,
        openingBalanceDate:
          account.openingBalanceDate ??
          (earliest?.date ? addDaysIso(earliest.date, -1) : null),
      })
      .where(eq(accounts.id, accountId));

    await recomputeAccountBalances([accountId]);

    if (!link.derivedAt) {
      await db
        .update(openFinanceAccountLinks)
        .set({ openingBalanceDerivedAt: new Date() })
        .where(eq(openFinanceAccountLinks.id, link.linkId));
    }
    corrections.push({ accountId, correctionMinor });
  }

  return corrections;
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
 * The category the provider suggests, if this user has one by that name.
 *
 * A starting point, not an authority: rules run after the sync and overwrite it.
 * A movement between the user's own accounts gets the transfer label rather than
 * a spending category, and a provider category this installation has no name for
 * is recorded as a gap rather than forced into something approximate.
 */
function resolveCategoryId(
  row: NormalizedTransaction,
  categoryIds: ReadonlyMap<string, string>,
  stats: OpenFinanceSyncStats,
): string | null {
  const match = providerCategoryName(row.providerCategory);
  if (match.kind === "unmapped") {
    if (row.providerCategory) {
      stats.unmappedCategories = [
        ...new Set([...(stats.unmappedCategories ?? []), row.providerCategory]),
      ];
    }
    return null;
  }
  const id = categoryIds.get(match.name);
  if (!id) {
    stats.missingCategories = [...new Set([...(stats.missingCategories ?? []), match.name])];
    return null;
  }
  return id;
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

/**
 * Turn bank outflows that settled a card bill into transfers.
 *
 * Only the bank side is ever stored. `deriveLedgerCycles` already reads card
 * payments that way — "a transfer is one row on the source account, its
 * destination leg is derived, never stored" — so this points the existing row at
 * the card rather than inventing a second one. `recomputeAccountBalances` then
 * credits the card automatically, which is what stops a card fed only with
 * purchases from drifting further into debt every month.
 *
 * Idempotent: a leg that has already been matched is not offered again, and a
 * row that is already a transfer is not a candidate.
 */
export async function pairCardPayments(
  userId: string,
): Promise<{ matched: number; ambiguous: number; touchedAccountIds: string[] }> {
  const legs = await db
    .select({
      cardAccountId: openFinanceCardPayments.accountId,
      date: openFinanceCardPayments.paidAt,
      amountMinor: openFinanceCardPayments.amountMinor,
      id: openFinanceCardPayments.id,
    })
    .from(openFinanceCardPayments)
    .where(
      and(
        eq(openFinanceCardPayments.userId, userId),
        isNull(openFinanceCardPayments.matchedTransactionId),
        isNotNull(openFinanceCardPayments.accountId),
      ),
    );
  if (legs.length === 0) return { matched: 0, ambiguous: 0, touchedAccountIds: [] };

  // Candidates are the rows the sync tagged as looking like a bill payment and
  // that are still ordinary expenses.
  const candidates = await db
    .select({
      transactionId: transactions.id,
      date: transactions.date,
      amountMinor: transactions.amountMinor,
    })
    .from(transactions)
    .innerJoin(
      transactionMetadata,
      eq(transactionMetadata.transactionId, transactions.id),
    )
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, "expense"),
        isNull(transactions.deletedAt),
        eq(transactionMetadata.key, "open_finance.card_payment_candidate"),
      ),
    );
  if (candidates.length === 0) return { matched: 0, ambiguous: 0, touchedAccountIds: [] };

  const legsByKey = new Map<string, string>();
  for (const leg of legs) legsByKey.set(`${leg.cardAccountId}|${leg.date}|${leg.amountMinor}`, leg.id);

  const decisions = matchCardPayments(
    candidates,
    legs.map((leg) => ({
      cardAccountId: leg.cardAccountId!,
      date: leg.date,
      amountMinor: leg.amountMinor,
    })) satisfies CardPaymentLeg[],
  );

  const [transferCategory] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.name, TRANSFER_CATEGORY_NAME)));
  const transferCategoryId = transferCategory?.id ?? null;

  let matched = 0;
  let ambiguous = 0;
  const touchedAccountIds = new Set<string>();
  for (const decision of decisions) {
    if (decision.kind === "ambiguous") {
      ambiguous += 1;
      continue;
    }
    if (decision.kind !== "matched") continue;

    const candidate = candidates.find((row) => row.transactionId === decision.transactionId)!;
    const legId = legsByKey.get(
      `${decision.cardAccountId}|${candidate.date}|${Math.abs(candidate.amountMinor)}`,
    );

    await db.transaction(async (trx) => {
      await trx
        .update(transactions)
        .set({
          type: "transfer",
          transferAccountId: decision.cardAccountId,
          // Labelled as a movement rather than left blank: whatever spending
          // category a rule guessed is wrong by definition (R5), but blank told
          // the reader nothing about what the row is.
          categoryId: transferCategoryId,
        })
        .where(eq(transactions.id, decision.transactionId));

      await trx
        .update(openFinanceCardPayments)
        .set({ matchedTransactionId: decision.transactionId, matchedAt: new Date() })
        .where(
          legId
            ? eq(openFinanceCardPayments.id, legId)
            : and(
                eq(openFinanceCardPayments.userId, userId),
                eq(openFinanceCardPayments.accountId, decision.cardAccountId),
                isNull(openFinanceCardPayments.matchedTransactionId),
              ),
        );

      await trx
        .insert(transactionMetadata)
        .values({
          transactionId: decision.transactionId,
          key: "open_finance.card_payment_matched",
          value: decision.cardAccountId,
        })
        .onConflictDoNothing();
    });
    matched += 1;
    touchedAccountIds.add(decision.cardAccountId);
  }

  return { matched, ambiguous, touchedAccountIds: [...touchedAccountIds] };
}
