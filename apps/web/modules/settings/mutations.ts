"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, userSettings } from "@kosh/db";
import { requireUser } from "@/lib/session";
import { logAudit } from "@/modules/shared/audit";

const updateSettingsSchema = z.object({
  currencyCode: z
    .string()
    .length(3)
    .transform((s) => s.toUpperCase())
    .optional(),
  locale: z.string().min(2).max(20).optional(),
  dateFormat: z.string().min(2).max(30).optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export async function updateUserSettings(input: UpdateSettingsInput) {
  const user = await requireUser();
  const data = updateSettingsSchema.parse(input);

  await db
    .insert(userSettings)
    .values({ userId: user.id, ...data })
    .onConflictDoUpdate({ target: [userSettings.userId], set: data });

  await logAudit({
    userId: user.id,
    action: "settings.changed",
    entityType: "user_settings",
    entityId: user.id,
    data: { changed: Object.keys(data) },
  });
  revalidatePath("/settings");
}
