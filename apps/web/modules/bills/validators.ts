import { z } from "zod";

export const recurrenceSchema = z.enum(["weekly", "monthly", "quarterly", "yearly"]);
export const amountStrategySchema = z.enum(["fixed", "variable"]);

export const createBillSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  /** Major units. */
  expectedAmount: z.coerce.number().positive("Amount must be positive"),
  currencyCode: z.string().length(3).default("INR"),
  recurrence: recurrenceSchema.default("monthly"),
  /**
   * A fixed bill always projects at `expectedAmount`. A variable one prefers
   * the amount of whichever transaction last actually paid it, falling back
   * to `expectedAmount` only until that history exists.
   */
  amountStrategy: amountStrategySchema.default("fixed"),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd"),
  accountId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  notes: z.string().max(2000).optional(),
});

export const updateBillSchema = createBillSchema.partial().extend({
  isActive: z.coerce.boolean().optional(),
});

export type CreateBillInput = z.infer<typeof createBillSchema>;
export type UpdateBillInput = z.infer<typeof updateBillSchema>;
