import { z } from "zod";

export const createRecurringSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(120),
    type: z.enum(["income", "expense", "transfer"]),
    accountId: z.string().uuid(),
    transferAccountId: z.string().uuid().nullish(),
    categoryId: z.string().uuid().nullish(),
    /** Major units, positive; sign derived from type. */
    amount: z.coerce.number().positive("Amount must be positive"),
    currencyCode: z.string().length(3).default("INR"),
    description: z.string().min(1).max(300),
    interval: z.enum(["weekly", "monthly", "quarterly", "yearly"]).default("monthly"),
    nextRunDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd"),
  })
  .refine((v) => v.type !== "transfer" || !!v.transferAccountId, {
    path: ["transferAccountId"],
    message: "Pick a destination account",
  });

export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
