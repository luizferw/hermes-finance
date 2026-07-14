import { z } from "zod";
import { withUser, ok, parseBody } from "@/modules/shared/api";
import { getUserSettings } from "@/modules/settings/queries";
import { updateUserSettings } from "@/modules/settings/mutations";

const updateSchema = z.object({
  currencyCode: z.string().length(3).optional(),
  locale: z.string().min(2).max(20).optional(),
  dateFormat: z.string().min(2).max(30).optional(),
});

export const GET = withUser(async (_req, { user }) => {
  return ok(await getUserSettings(user.id));
});

export const PATCH = withUser(async (req) => {
  const input = await parseBody(req, updateSchema);
  await updateUserSettings(input);
  return ok({ updated: true });
});
