import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, savingsGoals } from "@kosh/db";

export async function listGoals(userId: string) {
  return db.query.savingsGoals.findMany({
    where: eq(savingsGoals.userId, userId),
    with: { account: { columns: { id: true, name: true } } },
    orderBy: [asc(savingsGoals.createdAt)],
  });
}
