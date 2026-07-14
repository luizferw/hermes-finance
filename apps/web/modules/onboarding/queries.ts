import "server-only";
import { eq } from "drizzle-orm";
import { db, userSettings } from "@kosh/db";

/**
 * A user_settings row is written exactly once, when onboarding completes (or is
 * skipped). Its presence is our "first-run done" flag — no extra column needed.
 */
export async function isOnboarded(userId: string): Promise<boolean> {
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { userId: true },
  });
  return !!row;
}
