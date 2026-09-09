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

/**
 * Marking a bill paid can link an existing transaction, record a new one from
 * a typed amount (variable bills — PRD §9.10 wants the real payment, not the
 * estimate), or neither (fixed bills' plain one-click case). Never both an id
 * and an amount: that would be ambiguous about which fact is the real one.
 */
export const markBillPaidFields = {
  transactionId: z.string().uuid().optional(),
  /** Major units — what was actually paid. */
  amount: z.coerce.number().positive("Amount must be positive").optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd").optional(),
};

function refineMarkBillPaid<T extends { transactionId?: string; amount?: number }>(
  v: T,
) {
  return !(v.transactionId && v.amount !== undefined);
}

/** Used by the "mark paid" dialog, which supplies `billId` separately. */
export const markBillPaidFormSchema = z
  .object(markBillPaidFields)
  .refine(refineMarkBillPaid, {
    message: "Pick a transaction or enter an amount, not both",
    path: ["amount"],
  });

export const markBillPaidSchema = z
  .object({ billId: z.string().uuid(), ...markBillPaidFields })
  .refine(refineMarkBillPaid, {
    message: "Pick a transaction or enter an amount, not both",
    path: ["amount"],
  });

export type CreateBillInput = z.infer<typeof createBillSchema>;
export type UpdateBillInput = z.infer<typeof updateBillSchema>;
export type MarkBillPaidInput = z.infer<typeof markBillPaidSchema>;
export type MarkBillPaidFormInput = z.infer<typeof markBillPaidFormSchema>;
