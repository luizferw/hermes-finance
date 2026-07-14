import { z } from "zod";

export const createBudgetSchema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  categoryIds: z.array(z.string().uuid()).min(1, "Pick at least one category"),
  /** Planned amount per month, major units. */
  plannedAmount: z.coerce.number().positive("Plan a positive amount"),
  currencyCode: z.string().length(3).default("INR"),
});

export const updateBudgetSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  categoryIds: z.array(z.string().uuid()).min(1).optional(),
  plannedAmount: z.coerce.number().positive().optional(),
});

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;
