import "server-only";
import { eq } from "drizzle-orm";
import { db, userSettings } from "@kosh/db";

export interface UserSettingsData {
  country: string;
  currencyCode: string;
  locale: string;
  dateFormat: string;
  financialYearStartMonth: number;
}

const DEFAULTS: UserSettingsData = {
  country: "IN",
  currencyCode: "INR",
  locale: "en-IN",
  dateFormat: "dd MMM yyyy",
  financialYearStartMonth: 4,
};

export async function getUserSettings(userId: string): Promise<UserSettingsData> {
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!row) return DEFAULTS;
  return {
    country: row.country,
    currencyCode: row.currencyCode,
    locale: row.locale,
    dateFormat: row.dateFormat,
    financialYearStartMonth: row.financialYearStartMonth,
  };
}
