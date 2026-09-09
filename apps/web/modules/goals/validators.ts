import { z } from "zod";

export const createGoalSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  targetAmount: z.coerce.number().positive("Target must be positive"),
  currentAmount: z.coerce.number().min(0).default(0),
  currencyCode: z.string().length(3).default("INR"),
  accountId: z.string().uuid().nullish(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

/**
 * `currentAmount` is deliberately absent — `contributeToGoal` owns money
 * movement, and letting an edit form also set it would be two ways to change
 * the same balance.
 */
export const updateGoalSchema = z.object({
  name: z.string().min(1, "Name is required").max(120).optional(),
  targetAmount: z.coerce.number().positive("Target must be positive").optional(),
  currencyCode: z.string().length(3).optional(),
  accountId: z.string().uuid().nullish(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
