import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import {
  accounts,
  bills,
  budgets,
  categories,
  db,
  tags,
} from "@kosh/db";
import { ApiError } from "./api";

/**
 * Server-side ownership guards for foreign-key references taken from user input.
 *
 * Every referenceable table here is user-scoped, so accepting an id without
 * checking ownership is a cross-tenant IDOR (data corruption + info exposure).
 * These helpers throw a 404 `ApiError` (not 403) so they never reveal whether a
 * row exists for another user. They are deliberately set-based: one query per
 * table regardless of how many ids are passed.
 */

function distinctIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

async function assertOwned(
  userId: string,
  table: typeof accounts | typeof categories | typeof tags | typeof bills | typeof budgets,
  ids: ReadonlyArray<string | null | undefined>,
  label: string,
): Promise<void> {
  const wanted = distinctIds(ids);
  if (wanted.length === 0) return;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.userId, userId), inArray(table.id, wanted)));
  if (rows.length !== wanted.length) {
    throw new ApiError(404, "not_found", `${label} not found.`);
  }
}

export function assertAccountsOwned(
  userId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  return assertOwned(userId, accounts, ids, "Account");
}

export function assertCategoriesOwned(
  userId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  return assertOwned(userId, categories, ids, "Category");
}

export function assertTagsOwned(
  userId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  return assertOwned(userId, tags, ids, "Tag");
}

export function assertBillsOwned(
  userId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  return assertOwned(userId, bills, ids, "Bill");
}

export function assertBudgetsOwned(
  userId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  return assertOwned(userId, budgets, ids, "Budget");
}
