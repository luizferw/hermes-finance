"use server";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, openFinanceAccountLinks, openFinanceConnections } from "@kosh/db";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { assertAccountsOwned } from "@/modules/shared/ownership";
import { logAudit } from "@/modules/shared/audit";
import { getPluggyClient } from "./provider";
import {
  adoptConnectionSchema,
  connectTokenSchema,
  registerConnectionSchema,
  updateAccountLinkSchema,
  updateConnectionSchema,
  type AdoptConnectionInput,
  type ConnectTokenInput,
  type RegisterConnectionInput,
  type UpdateAccountLinkInput,
  type UpdateConnectionInput,
} from "./validators";
import { syncConnection, type SyncRunSummary } from "./sync";

function revalidateOpenFinance(): void {
  revalidatePath("/settings/open-finance");
  revalidatePath("/accounts");
  revalidatePath("/overview");
}

/**
 * Mint a connect token for the widget.
 *
 * Ownership is checked before the token is minted, not after: a token carrying
 * an `itemId` authorizes the widget to reach that Item, so handing one out for a
 * connection the session user does not own would be a cross-tenant hole that no
 * later check could close.
 */
export async function createConnectTokenCore(userId: string, input: ConnectTokenInput) {
  const data = connectTokenSchema.parse(input);
  const client = getPluggyClient();
  if (!client) return null;

  let itemId: string | undefined;
  if (data.connectionId) {
    const connection = await db.query.openFinanceConnections.findFirst({
      where: and(
        eq(openFinanceConnections.id, data.connectionId),
        eq(openFinanceConnections.userId, userId),
      ),
    });
    if (!connection) throw new ApiError(404, "not_found", "Connection not found.");
    itemId = connection.itemId;
  }

  const accessToken = await client.createConnectToken({ itemId, clientUserId: userId });
  return { accessToken, itemId: itemId ?? null };
}

/**
 * Take ownership of an Item the user just created in the widget.
 *
 * The widget reports the Item id on success and this is where it becomes ours.
 * An Item that is already registered is not an error: `avoidDuplicates` makes
 * Pluggy hand back the existing connection when the same bank is connected
 * twice, and a reconnection returns the very Item being repaired.
 */
export async function adoptConnectionCore(userId: string, input: AdoptConnectionInput) {
  const data = adoptConnectionSchema.parse(input);

  const existing = await db.query.openFinanceConnections.findFirst({
    where: and(
      eq(openFinanceConnections.userId, userId),
      eq(openFinanceConnections.itemId, data.itemId),
    ),
  });
  if (existing) return existing;

  const [connection] = await db
    .insert(openFinanceConnections)
    .values({ userId, itemId: data.itemId, label: data.label ?? null })
    .returning();

  await logAudit({
    userId,
    action: "open_finance.connection_created",
    entityType: "open_finance_connection",
    entityId: connection!.id,
  });
  return connection!;
}

/**
 * Called by the widget's success handler: adopt the connection and pull it in.
 *
 * The first sync runs immediately because a connection that shows up empty is
 * indistinguishable, to the user, from one that failed.
 */
export async function adoptConnection(input: AdoptConnectionInput) {
  const user = await requireUser();
  const connection = await adoptConnectionCore(user.id, input);
  const summary = await syncConnection(user.id, connection.id, { trigger: "manual" });
  revalidateOpenFinance();
  return { connection, summary };
}

/**
 * Register a connection the user already created at meu.pluggy.ai.
 *
 * All Hermes does is remember the item id. It never creates, updates or deletes
 * a bank connection, so there is no consent flow here and no credentials cross
 * this boundary.
 */
export async function registerConnectionCore(userId: string, input: RegisterConnectionInput) {
  const data = registerConnectionSchema.parse(input);

  const existing = await db.query.openFinanceConnections.findFirst({
    where: and(
      eq(openFinanceConnections.userId, userId),
      eq(openFinanceConnections.itemId, data.itemId),
    ),
  });
  if (existing) {
    throw new ApiError(409, "already_registered", "This Item is already connected.");
  }

  const [connection] = await db
    .insert(openFinanceConnections)
    .values({ userId, itemId: data.itemId, label: data.label ?? null })
    .returning();

  await logAudit({
    userId,
    action: "open_finance.connection_registered",
    entityType: "open_finance_connection",
    entityId: connection!.id,
  });
  return connection!;
}

export async function registerConnection(input: RegisterConnectionInput) {
  const user = await requireUser();
  const connection = await registerConnectionCore(user.id, input);
  revalidateOpenFinance();
  return connection;
}

export async function updateConnectionCore(userId: string, input: UpdateConnectionInput) {
  const data = updateConnectionSchema.parse(input);
  const [updated] = await db
    .update(openFinanceConnections)
    .set({
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    })
    .where(
      and(
        eq(openFinanceConnections.id, data.connectionId),
        eq(openFinanceConnections.userId, userId),
      ),
    )
    .returning();
  if (!updated) throw new ApiError(404, "not_found", "Connection not found.");
  return updated;
}

export async function updateConnection(input: UpdateConnectionInput) {
  const user = await requireUser();
  const updated = await updateConnectionCore(user.id, input);
  revalidateOpenFinance();
  return updated;
}

/**
 * Forget a connection.
 *
 * The accounts and transactions it produced are left alone: they are ledger
 * history, and history does not stop being true because the pipe that delivered
 * it was removed. Only the link to the provider goes.
 */
export async function removeConnectionCore(userId: string, connectionId: string) {
  const deleted = await db
    .delete(openFinanceConnections)
    .where(
      and(
        eq(openFinanceConnections.id, connectionId),
        eq(openFinanceConnections.userId, userId),
      ),
    )
    .returning({ id: openFinanceConnections.id });
  if (deleted.length === 0) throw new ApiError(404, "not_found", "Connection not found.");

  await logAudit({
    userId,
    action: "open_finance.connection_removed",
    entityType: "open_finance_connection",
    entityId: connectionId,
  });
}

export async function removeConnection(connectionId: string) {
  const user = await requireUser();
  await removeConnectionCore(user.id, connectionId);
  revalidateOpenFinance();
}

/**
 * Override which Hermes account a provider account feeds.
 *
 * Passing a null account id parks the provider account as `ignored`, which is
 * how a user says "this one is not mine to track". The previous account keeps
 * everything already imported into it.
 */
export async function updateAccountLinkCore(userId: string, input: UpdateAccountLinkInput) {
  const data = updateAccountLinkSchema.parse(input);
  // The account id arrives from user input, so it is checked before it is
  // written: without this it would be a cross-tenant IDOR.
  await assertAccountsOwned(userId, [data.accountId]);

  const [updated] = await db
    .update(openFinanceAccountLinks)
    .set({
      accountId: data.accountId,
      linkMode: data.accountId ? "manual" : "ignored",
      linkConfidence: null,
      linkDecisionNote: data.accountId
        ? "linked manually"
        : "ignored at your request",
      isSyncEnabled: data.isSyncEnabled ?? Boolean(data.accountId),
      // The watermark is cleared so the next sync re-reads the full history into
      // whichever account it now points at.
      syncedThrough: null,
      openingBalanceDerivedAt: null,
    })
    .where(
      and(
        eq(openFinanceAccountLinks.id, data.linkId),
        eq(openFinanceAccountLinks.userId, userId),
      ),
    )
    .returning();
  if (!updated) throw new ApiError(404, "not_found", "Link not found.");

  await logAudit({
    userId,
    action: "open_finance.link_overridden",
    entityType: "open_finance_account_link",
    entityId: data.linkId,
    data: { accountId: data.accountId },
  });
  return updated;
}

export async function updateAccountLink(input: UpdateAccountLinkInput) {
  const user = await requireUser();
  const updated = await updateAccountLinkCore(user.id, input);
  revalidateOpenFinance();
  return updated;
}

export async function syncConnectionNow(connectionId: string): Promise<SyncRunSummary> {
  const user = await requireUser();
  const summary = await syncConnection(user.id, connectionId, { trigger: "manual" });
  revalidateOpenFinance();
  return summary;
}
