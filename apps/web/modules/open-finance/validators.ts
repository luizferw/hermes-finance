import { z } from "zod";

/** Pluggy item ids are uuids; rejecting anything else keeps a typo out of the API. */
export const registerConnectionSchema = z.object({
  itemId: z.string().trim().uuid("Paste the Item ID copied from the Pluggy dashboard."),
  label: z.string().trim().max(120).optional(),
});

export const connectionIdSchema = z.object({
  connectionId: z.string().uuid(),
});

export const updateConnectionSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string().trim().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Overriding a link decision. `accountId: null` with `ignored` is how a user
 * says "this provider account is not mine to track".
 */
export const updateAccountLinkSchema = z.object({
  linkId: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  isSyncEnabled: z.boolean().optional(),
});

export const syncTriggerSchema = z.enum(["scheduled", "manual"]);

export type RegisterConnectionInput = z.input<typeof registerConnectionSchema>;
export type UpdateConnectionInput = z.input<typeof updateConnectionSchema>;
export type UpdateAccountLinkInput = z.input<typeof updateAccountLinkSchema>;
export type SyncTrigger = z.infer<typeof syncTriggerSchema>;
