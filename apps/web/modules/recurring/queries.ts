import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, recurringTransactions } from "@kosh/db";

export async function listRecurring(userId: string) {
  return db.query.recurringTransactions.findMany({
    where: eq(recurringTransactions.userId, userId),
    with: {
      account: { columns: { id: true, name: true } },
      category: { columns: { id: true, name: true, color: true } },
    },
    orderBy: [asc(recurringTransactions.nextRunDate)],
  });
}
