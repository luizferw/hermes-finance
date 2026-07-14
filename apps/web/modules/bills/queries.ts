import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { bills, db } from "@kosh/db";
import { billState, daysBetween, todayIso, type BillState } from "@kosh/domain";

export interface BillWithState {
  bill: typeof bills.$inferSelect & {
    account: { id: string; name: string } | null;
    category: { id: string; name: string; color: string | null } | null;
  };
  state: BillState;
  daysUntilDue: number;
}

export async function listBills(userId: string): Promise<BillWithState[]> {
  const rows = await db.query.bills.findMany({
    where: eq(bills.userId, userId),
    with: {
      account: { columns: { id: true, name: true } },
      category: { columns: { id: true, name: true, color: true } },
    },
    orderBy: [asc(bills.nextDueDate)],
  });
  const today = todayIso();
  return rows.map((bill) => ({
    bill,
    state: billState(bill, today),
    daysUntilDue: daysBetween(today, bill.nextDueDate),
  }));
}

/** Active bills due in the next `days` days, plus anything overdue. */
export async function getUpcomingBills(
  userId: string,
  days = 14,
): Promise<BillWithState[]> {
  const all = await listBills(userId);
  return all.filter(
    ({ bill, state, daysUntilDue }) =>
      bill.isActive && (state === "overdue" || daysUntilDue <= days),
  );
}

export async function getBill(userId: string, id: string) {
  return db.query.bills.findFirst({
    where: and(eq(bills.id, id), eq(bills.userId, userId)),
    with: { account: true, category: true },
  });
}
