import { z } from "zod";

export const transactionTypeSchema = z.enum([
  "income",
  "expense",
  "transfer",
  "adjustment",
  "opening_balance",
]);

export const transactionStatusSchema = z.enum([
  "pending",
  "imported",
  "reviewed",
  "posted",
  "rejected",
]);

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd");

export const createTransactionSchema = z
  .object({
    accountId: z.string().uuid(),
    transferAccountId: z.string().uuid().optional(),
    type: z.enum(["income", "expense", "transfer"]),
    date: isoDateSchema,
    /** Major units, always positive in forms; sign derived from type. */
    amount: z.coerce.number().positive("Amount must be positive"),
    description: z.string().min(1, "Description is required").max(300),
    merchant: z.string().max(150).optional(),
    categoryId: z.string().uuid().nullish(),
    notes: z.string().max(2000).optional(),
    tagIds: z.array(z.string().uuid()).max(20).optional(),
    /**
     * "posted" counts immediately (default for confirmed entries); "pending"
     * parks the entry in the inbox for review and keeps it out of balances
     * until approved. Used by quick-add's "review later".
     */
    status: z.enum(["posted", "pending"]).optional(),
  })
  .refine((v) => v.type !== "transfer" || !!v.transferAccountId, {
    path: ["transferAccountId"],
    message: "Pick a destination account for the transfer",
  })
  .refine((v) => v.transferAccountId === undefined || v.transferAccountId !== v.accountId, {
    path: ["transferAccountId"],
    message: "Source and destination must differ",
  });

export const updateTransactionSchema = z.object({
  date: isoDateSchema.optional(),
  description: z.string().min(1).max(300).optional(),
  merchant: z.string().max(150).nullish(),
  categoryId: z.string().uuid().nullish(),
  notes: z.string().max(2000).nullish(),
  status: transactionStatusSchema.optional(),
  tagIds: z.array(z.string().uuid()).max(20).optional(),
});

export const listTransactionsSchema = z.object({
  q: z.string().max(200).optional(),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  status: transactionStatusSchema.optional(),
  type: transactionTypeSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** Major units. */
  minAmount: z.coerce.number().optional(),
  maxAmount: z.coerce.number().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const bulkIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;
