import "server-only";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { categories, db, tags, transactionTags, transactions } from "@kosh/db";

export async function listCategories(userId: string) {
  return db.query.categories.findMany({
    where: eq(categories.userId, userId),
    orderBy: [asc(categories.name)],
  });
}

export async function listTags(userId: string) {
  return db.query.tags.findMany({
    where: eq(tags.userId, userId),
    orderBy: [asc(tags.name)],
  });
}

/**
 * Tags with how many non-deleted transactions carry each one (every status).
 * The tags list itself is what GET /api/tags returns; the count is what tells
 * an unused tag from a live one.
 */
export async function listTagsWithUsage(userId: string) {
  const [all, usage] = await Promise.all([
    listTags(userId),
    db
      .select({ tagId: transactionTags.tagId, value: count() })
      .from(transactionTags)
      .innerJoin(transactions, eq(transactions.id, transactionTags.transactionId))
      .innerJoin(tags, eq(tags.id, transactionTags.tagId))
      .where(and(eq(tags.userId, userId), eq(transactions.userId, userId), isNull(transactions.deletedAt)))
      .groupBy(transactionTags.tagId),
  ]);
  const byTag = new Map(usage.map((u) => [u.tagId, u.value]));
  return all.map((tag) => ({ ...tag, transactionCount: byTag.get(tag.id) ?? 0 }));
}
