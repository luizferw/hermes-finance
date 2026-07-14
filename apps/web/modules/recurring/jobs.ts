import "server-only";
import { and, eq, lte } from "drizzle-orm";
import {
  db,
  recurringTransactions,
  transactionSplits,
  transactions,
} from "@kosh/db";
import { addInterval, todayIso } from "@kosh/domain";

/**
 * Generate draft transactions (status: pending) for every active recurring
 * template that is due. Drafts land in the inbox — nothing posts silently.
 * Runs from the pg-boss job and can be triggered manually.
 */
export async function generateDueRecurringTransactions(): Promise<number> {
  const today = todayIso();
  const due = await db.query.recurringTransactions.findMany({
    where: and(
      eq(recurringTransactions.isActive, true),
      lte(recurringTransactions.nextRunDate, today),
    ),
  });

  let generated = 0;
  for (const template of due) {
    // Roll forward through any missed periods, generating one draft per period.
    let runDate = template.nextRunDate;
    let guard = 0;
    while (runDate <= today && guard < 24) {
      const [tx] = await db
        .insert(transactions)
        .values({
          userId: template.userId,
          accountId: template.accountId,
          transferAccountId: template.transferAccountId,
          type: template.type,
          status: "pending",
          date: runDate,
          amountMinor: template.amountMinor,
          currencyCode: template.currencyCode,
          description: template.description,
          categoryId: template.categoryId,
          recurringTransactionId: template.id,
        })
        .returning();
      await db.insert(transactionSplits).values({
        transactionId: tx!.id,
        categoryId: template.categoryId,
        amountMinor: template.amountMinor,
        sortOrder: 0,
      });
      generated += 1;
      runDate = addInterval(runDate, template.interval);
      guard += 1;
    }
    await db
      .update(recurringTransactions)
      .set({ nextRunDate: runDate, lastRunDate: today })
      .where(eq(recurringTransactions.id, template.id));
  }
  return generated;
}
