import "server-only";
import { asc, eq } from "drizzle-orm";
import { categories, db, tags } from "@kosh/db";

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
