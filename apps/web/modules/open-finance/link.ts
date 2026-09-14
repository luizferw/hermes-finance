import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  accounts,
  openFinanceAccountLinks,
  type OpenFinanceLinkMode,
} from "@kosh/db";
import {
  hermesAccountTypeFor,
  matchAccountCandidate,
  proposeAccountName,
  uniqueAccountName,
  type AccountMatchCandidate,
  type NormalizedAccount,
} from "@hermes-finance/open-finance";
import type { Trx } from "./types";

export interface ResolvedLink {
  linkId: string;
  accountId: string | null;
  mode: OpenFinanceLinkMode;
  note: string;
  /** True on the run that created the account, which is when the opening balance is back-solved. */
  createdAccount: boolean;
  /** An ambiguous match is a decision a human still owes (PRD §14). */
  needsReview: boolean;
}

/**
 * Attach a provider account to a Hermes account, creating one if needed.
 *
 * The decision is made once and then stored: a link that already exists is
 * reused without re-matching, because re-deciding every run risks deciding
 * differently and forking one account's history across two.
 */
export async function resolveAccountLink(
  trx: Trx,
  userId: string,
  connection: { id: string; connectorName: string | null },
  incoming: NormalizedAccount,
): Promise<ResolvedLink> {
  const existing = await trx.query.openFinanceAccountLinks.findFirst({
    where: and(
      eq(openFinanceAccountLinks.connectionId, connection.id),
      eq(openFinanceAccountLinks.providerAccountId, incoming.externalId),
    ),
  });

  const hermesType = hermesAccountTypeFor(incoming.providerType, incoming.subtype);

  const shared = {
    userId,
    connectionId: connection.id,
    providerAccountId: incoming.externalId,
    providerType: incoming.providerType,
    providerSubtype: incoming.subtype,
    providerName: incoming.name,
    providerNumberMask: incoming.numberMask,
    currencyCode: incoming.currencyCode,
    providerBalanceMinor: incoming.balanceMinor,
    providerBalanceObservedAt: new Date(),
  };

  // A type Hermes has no model for is recorded and skipped rather than forced
  // into the nearest thing, which would put numbers nobody can explain into the
  // forecast.
  if (!hermesType) {
    const note = `Hermes has no model for a ${incoming.providerType}/${incoming.subtype ?? "unknown"} account yet`;
    const linkId = await upsertLink(trx, existing?.id, {
      ...shared,
      accountId: null,
      linkMode: "unsupported",
      linkConfidence: null,
      linkDecisionNote: note,
      isSyncEnabled: false,
    });
    return { linkId, accountId: null, mode: "unsupported", note, createdAccount: false, needsReview: false };
  }

  // A decision already made — by an earlier run or by the user — stands.
  if (existing && (existing.accountId || existing.linkMode === "ignored")) {
    await trx
      .update(openFinanceAccountLinks)
      .set({
        providerName: incoming.name,
        providerNumberMask: incoming.numberMask,
        providerBalanceMinor: incoming.balanceMinor,
        providerBalanceObservedAt: new Date(),
      })
      .where(eq(openFinanceAccountLinks.id, existing.id));
    return {
      linkId: existing.id,
      accountId: existing.accountId,
      mode: existing.linkMode,
      note: existing.linkDecisionNote ?? "",
      createdAccount: false,
      needsReview: false,
    };
  }

  const { candidates, takenNames } = await loadOwnAccounts(trx, userId);
  const decision = matchAccountCandidate(
    {
      name: incoming.name,
      connectorName: connection.connectorName,
      numberMask: incoming.numberMask,
      currencyCode: incoming.currencyCode,
      hermesType,
    },
    candidates,
  );

  if (decision.kind === "match") {
    const linkId = await upsertLink(trx, existing?.id, {
      ...shared,
      accountId: decision.accountId,
      linkMode: "matched_existing",
      linkConfidence: decision.confidence,
      linkDecisionNote: decision.note,
      isSyncEnabled: true,
    });
    return {
      linkId,
      accountId: decision.accountId,
      mode: "matched_existing",
      note: decision.note,
      createdAccount: false,
      needsReview: false,
    };
  }

  const name = uniqueAccountName(
    proposeAccountName({
      connectorName: connection.connectorName,
      providerName: incoming.name,
      numberMask: incoming.numberMask,
    }),
    takenNames,
  );

  const [created] = await trx
    .insert(accounts)
    .values({
      userId,
      name,
      type: hermesType,
      currencyCode: incoming.currencyCode,
      institution: connection.connectorName,
      accountNumberMask: incoming.numberMask,
      // Left at zero on purpose. The sync back-solves it once the history has
      // landed, so the ledger ends on the balance the bank reports.
      openingBalanceMinor: 0,
      currentBalanceMinor: 0,
      limitMinor: incoming.creditLimitMinor,
    })
    .returning({ id: accounts.id });

  const note =
    decision.kind === "ambiguous"
      ? `created account "${name}". ${decision.note}`
      : `created account "${name}"`;

  const linkId = await upsertLink(trx, existing?.id, {
    ...shared,
    accountId: created!.id,
    linkMode: "auto_created",
    linkConfidence: null,
    linkDecisionNote: note,
    isSyncEnabled: true,
  });

  return {
    linkId,
    accountId: created!.id,
    mode: "auto_created",
    note,
    createdAccount: true,
    needsReview: decision.kind === "ambiguous",
  };
}

/**
 * The user's own accounts, as match candidates.
 *
 * `accountNumberMask` is an `encryptedText` column: AES-GCM uses a random IV per
 * write, so a WHERE on it silently matches nothing. The rows are therefore read
 * out and compared in memory. A user has tens of accounts, not thousands.
 */
async function loadOwnAccounts(
  trx: Trx,
  userId: string,
): Promise<{ candidates: AccountMatchCandidate[]; takenNames: Set<string> }> {
  const rows = await trx
    .select({
      id: accounts.id,
      name: accounts.name,
      institution: accounts.institution,
      numberMask: accounts.accountNumberMask,
      currencyCode: accounts.currencyCode,
      type: accounts.type,
      isArchived: accounts.isArchived,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));

  const alreadyLinked = await trx
    .select({ accountId: openFinanceAccountLinks.accountId })
    .from(openFinanceAccountLinks)
    .where(
      and(
        eq(openFinanceAccountLinks.userId, userId),
        isNotNull(openFinanceAccountLinks.accountId),
      ),
    );
  const linkedIds = new Set(alreadyLinked.map((row) => row.accountId));

  return {
    // Every name is taken, archived ones included: the unique index does not
    // care whether an account is archived.
    takenNames: new Set(rows.map((row) => row.name)),
    candidates: rows
      .filter((row) => !row.isArchived && !linkedIds.has(row.id))
      .map((row) => ({
        accountId: row.id,
        name: row.name,
        institution: row.institution,
        numberMask: row.numberMask,
        currencyCode: row.currencyCode,
        type: row.type,
      })),
  };
}

async function upsertLink(
  trx: Trx,
  existingId: string | undefined,
  values: typeof openFinanceAccountLinks.$inferInsert,
): Promise<string> {
  if (existingId) {
    await trx
      .update(openFinanceAccountLinks)
      .set(values)
      .where(eq(openFinanceAccountLinks.id, existingId));
    return existingId;
  }
  const [inserted] = await trx
    .insert(openFinanceAccountLinks)
    .values(values)
    .returning({ id: openFinanceAccountLinks.id });
  return inserted!.id;
}

/** Links this connection can actually sync, in a stable order. */
export async function listSyncableLinks(trx: Trx, connectionId: string) {
  return trx.query.openFinanceAccountLinks.findMany({
    where: and(
      eq(openFinanceAccountLinks.connectionId, connectionId),
      eq(openFinanceAccountLinks.isSyncEnabled, true),
      isNotNull(openFinanceAccountLinks.accountId),
    ),
  });
}

/** Provider accounts still waiting on a decision, for the settings screen. */
export async function listUnlinked(trx: Trx, userId: string) {
  return trx.query.openFinanceAccountLinks.findMany({
    where: and(
      eq(openFinanceAccountLinks.userId, userId),
      isNull(openFinanceAccountLinks.accountId),
    ),
  });
}
