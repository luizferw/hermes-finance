import { z } from "zod";

export const accountTypeSchema = z.enum([
  "asset",
  "cash",
  "wallet",
  "credit_card",
  "liability",
  "investment",
]);

export const createAccountSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  type: accountTypeSchema,
  currencyCode: z
    .string()
    .length(3)
    .transform((s) => s.toUpperCase())
    .default("INR"),
  institution: z.string().max(120).optional(),
  accountNumberMask: z.string().max(20).optional(),
  upiId: z.string().max(120).optional(),
  /** Major units in the form; converted to minor units in the mutation. */
  openingBalance: z.coerce.number().default(0),
  openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().optional(),
  includeInNetWorth: z.boolean().default(true),
  notes: z.string().max(2000).optional(),
});

export const updateAccountSchema = createAccountSchema
  .partial()
  .extend({ isArchived: z.boolean().optional() });

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
