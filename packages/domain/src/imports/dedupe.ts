/**
 * Duplicate detection for imported transactions.
 *
 * Two layers:
 * 1. Exact: stable hash of (account, date, amount, normalized description)
 *    or a matching external id.
 * 2. Fuzzy: same account + amount within ±1 day, flagged as a *candidate*
 *    for human review, never auto-rejected.
 */

import { daysBetween } from "../shared/dates";

function fnv1a(input: string): string {
  // 64-bit FNV-1a, returned as hex. Stable, fast, dependency-free; this is a
  // fingerprint for dedupe, not a security boundary.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function normalizeDescription(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ImportHashInput {
  accountId: string;
  date: string;
  amountMinor: number;
  description: string;
}

export function computeImportHash(input: ImportHashInput): string {
  return fnv1a(
    [
      input.accountId,
      input.date,
      String(input.amountMinor),
      normalizeDescription(input.description),
    ].join("|"),
  );
}

export interface ExistingTransactionLike {
  id: string;
  date: string;
  amountMinor: number;
  importHash: string | null;
  externalId: string | null;
}

export interface IncomingRowLike {
  date: string;
  amountMinor: number;
  description: string;
  externalId: string | null;
}

export type DuplicateMatch =
  | { kind: "exact"; transactionId: string; reason: "hash" | "external_id" }
  | { kind: "fuzzy"; transactionId: string; reason: "amount_near_date" };

/**
 * Find the best duplicate match for an incoming row among existing
 * transactions of the same account. Exact matches win over fuzzy ones.
 */
export function findDuplicate(
  accountId: string,
  row: IncomingRowLike,
  existing: ExistingTransactionLike[],
): DuplicateMatch | null {
  if (row.externalId) {
    const byExternalId = existing.find(
      (t) => t.externalId !== null && t.externalId === row.externalId,
    );
    if (byExternalId) {
      return { kind: "exact", transactionId: byExternalId.id, reason: "external_id" };
    }
  }

  const hash = computeImportHash({
    accountId,
    date: row.date,
    amountMinor: row.amountMinor,
    description: row.description,
  });
  const byHash = existing.find((t) => t.importHash === hash);
  if (byHash) {
    return { kind: "exact", transactionId: byHash.id, reason: "hash" };
  }

  const fuzzy = existing.find(
    (t) =>
      t.amountMinor === row.amountMinor &&
      Math.abs(daysBetween(t.date, row.date)) <= 1,
  );
  if (fuzzy) {
    return { kind: "fuzzy", transactionId: fuzzy.id, reason: "amount_near_date" };
  }

  return null;
}

/** Detect duplicates *within* a batch of incoming rows (same file). */
export function findIntraBatchDuplicates(
  accountId: string,
  rows: IncomingRowLike[],
): Set<number> {
  const seen = new Map<string, number>();
  const duplicates = new Set<number>();
  rows.forEach((row, index) => {
    const key = row.externalId
      ? `ext:${row.externalId}`
      : computeImportHash({
          accountId,
          date: row.date,
          amountMinor: row.amountMinor,
          description: row.description,
        });
    if (seen.has(key)) {
      duplicates.add(index);
    } else {
      seen.set(key, index);
    }
  });
  return duplicates;
}
