"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { db, categories, userSettings } from "@kosh/db";
import { requireUser } from "@/lib/session";
import { logAudit } from "@/modules/shared/audit";
import { createAccount } from "@/modules/accounts/mutations";
import { accountTypeSchema } from "@/modules/accounts/validators";
import { isOnboarded } from "./queries";
import { CATEGORY_TIERS, regionByKey } from "./data";

const completeOnboardingSchema = z.object({
  regionKey: z.string().min(1),
  categoryTier: z.enum(["minimal", "recommended", "advanced"]),
  accounts: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        type: accountTypeSchema,
        openingBalance: z.coerce.number().default(0),
      }),
    )
    .max(20),
});

export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>;

export async function completeOnboarding(input: CompleteOnboardingInput) {
  const user = await requireUser();

  // Idempotent: if a settings row already exists, onboarding is done.
  if (await isOnboarded(user.id)) redirect("/overview");

  const data = completeOnboardingSchema.parse(input);
  const region = regionByKey(data.regionKey);
  if (!region) throw new Error("Unknown region");

  // 1. Region settings — also the "onboarded" marker.
  await db.insert(userSettings).values({
    userId: user.id,
    country: region.country,
    currencyCode: region.currencyCode,
    locale: region.locale,
    financialYearStartMonth: region.financialYearStartMonth,
  });

  // 2. Seed the chosen category tier (one bulk insert).
  const tier = CATEGORY_TIERS[data.categoryTier];
  if (tier.length > 0) {
    await db
      .insert(categories)
      .values(tier.map((c) => ({ userId: user.id, name: c.name, color: c.color })))
      .onConflictDoNothing();
  }

  // 3. Accounts (reuses createAccount → opening balance + ledger snapshot).
  // sequential reuse, not one big txn. A partial onboarding is
  // recoverable from the accounts screen; correctness per-account is intact.
  for (const account of data.accounts) {
    await createAccount({
      name: account.name,
      type: account.type,
      currencyCode: region.currencyCode,
      openingBalance: account.openingBalance,
      includeInNetWorth: true,
    });
  }

  await logAudit({
    userId: user.id,
    action: "onboarding.completed",
    entityType: "user",
    entityId: user.id,
    data: {
      region: region.key,
      accounts: data.accounts.length,
      categoryTier: data.categoryTier,
    },
  });

  redirect("/overview");
}
