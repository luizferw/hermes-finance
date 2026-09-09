import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd");
const currencyCodeSchema = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase())
  .refine((s) => /^[A-Z]{3}$/.test(s), "Currency code must be 3 letters");
const dayOfMonthSchema = z.coerce.number().int().min(1).max(31);

// --- balance snapshots ------------------------------------------------------

export const upsertBalanceSnapshotSchema = z.object({
  accountId: z.string().uuid(),
  /** Major units; converted to minor units against the account's own currency. */
  amount: z.coerce.number(),
  observedAt: isoDate,
  source: z.string().min(1).max(60).default("manual"),
});

export type UpsertBalanceSnapshotInput = z.infer<typeof upsertBalanceSnapshotSchema>;

// --- financial reserves ------------------------------------------------------

export const reserveKindSchema = z.enum(["hard", "soft"]);

export const createFinancialReserveSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  kind: reserveKindSchema,
  /** Major units. */
  amount: z.coerce.number().nonnegative("Amount must not be negative"),
  currencyCode: currencyCodeSchema.default("BRL"),
  isActive: z.boolean().default(true),
});

export const updateFinancialReserveSchema = createFinancialReserveSchema.partial();

export type CreateFinancialReserveInput = z.infer<typeof createFinancialReserveSchema>;
export type UpdateFinancialReserveInput = z.infer<typeof updateFinancialReserveSchema>;

// --- credit cards ------------------------------------------------------------

export const createCreditCardSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().min(1, "Name is required").max(120),
  issuer: z.string().max(120).optional(),
  currencyCode: currencyCodeSchema.default("BRL"),
  /** Major units. */
  creditLimit: z.coerce.number().nonnegative("Credit limit must not be negative"),
  defaultClosingDay: dayOfMonthSchema,
  defaultDueDay: dayOfMonthSchema,
  paymentAccountId: z.string().uuid().nullish(),
  active: z.boolean().default(true),
});

export const updateCreditCardSchema = createCreditCardSchema
  .omit({ accountId: true })
  .partial();

export type CreateCreditCardInput = z.infer<typeof createCreditCardSchema>;
export type UpdateCreditCardInput = z.infer<typeof updateCreditCardSchema>;

// --- credit card billing cycles ----------------------------------------------

export const cardCycleStatusSchema = z.enum(["open", "closed", "paid", "overdue", "needs_review"]);

export const createBillingCycleSchema = z.object({
  creditCardId: z.string().uuid(),
  statementMonth: z.string().regex(/^\d{4}-\d{2}$/, "Use yyyy-MM"),
  openedAt: isoDate,
  closedAt: isoDate.nullish(),
  dueAt: isoDate,
  /** Major units; the reconciled statement total once the bill has arrived. */
  confirmedTotal: z.coerce.number().nonnegative().nullish(),
  source: z.string().min(1).max(60).default("manual"),
  status: cardCycleStatusSchema.default("open"),
});

export const updateBillingCycleSchema = createBillingCycleSchema
  .omit({ creditCardId: true, statementMonth: true })
  .partial();

export const reconcileBillingCycleSchema = z.object({
  /** Major units. */
  confirmedTotal: z.coerce.number().nonnegative("Amount must not be negative"),
  status: cardCycleStatusSchema.default("closed"),
});

export type CreateBillingCycleInput = z.infer<typeof createBillingCycleSchema>;
export type UpdateBillingCycleInput = z.infer<typeof updateBillingCycleSchema>;
export type ReconcileBillingCycleInput = z.infer<typeof reconcileBillingCycleSchema>;

// --- card purchases + installment plans ---------------------------------------

export const registerCardPurchaseSchema = z.object({
  creditCardId: z.string().uuid(),
  purchaseDate: isoDate,
  /** Major units; the full price of the purchase. */
  totalAmount: z.coerce.number().positive("Total amount must be positive"),
  totalInstallments: z.coerce.number().int().positive().default(1),
  description: z.string().min(1, "Description is required").max(200),
  merchant: z.string().max(120).optional(),
  categoryId: z.string().uuid().nullish(),
});

export type RegisterCardPurchaseInput = z.infer<typeof registerCardPurchaseSchema>;

// --- purchase plans ------------------------------------------------------------

export const purchasePlanStatusSchema = z.enum(["active", "completed", "archived"]);

export const createPurchasePlanSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  description: z.string().max(2000).optional(),
  targetDate: isoDate.nullish(),
  /** Major units. */
  budget: z.coerce.number().nonnegative().nullish(),
  currencyCode: currencyCodeSchema.default("BRL"),
  status: purchasePlanStatusSchema.default("active"),
});

export const updatePurchasePlanSchema = createPurchasePlanSchema.partial();

export type CreatePurchasePlanInput = z.infer<typeof createPurchasePlanSchema>;
export type UpdatePurchasePlanInput = z.infer<typeof updatePurchasePlanSchema>;

// --- purchase items --------------------------------------------------------------

export const purchaseItemPrioritySchema = z.enum(["must_have", "high", "medium", "low", "optional"]);
export const purchaseItemStatusSchema = z.enum(["idea", "planned", "ready", "purchased", "cancelled"]);

export const createPurchaseItemSchema = z.object({
  purchasePlanId: z.string().uuid(),
  name: z.string().min(1, "Name is required").max(120),
  priority: purchaseItemPrioritySchema.default("medium"),
  /** Major units. */
  estimatedPrice: z.coerce.number().nonnegative("Estimated price must not be negative"),
  actualPrice: z.coerce.number().nonnegative().nullish(),
  earliestPurchaseDate: isoDate.nullish(),
  deadline: isoDate.nullish(),
  status: purchaseItemStatusSchema.default("idea"),
  notes: z.string().max(2000).optional(),
});

export const updatePurchaseItemSchema = createPurchaseItemSchema
  .omit({ purchasePlanId: true })
  .partial();

export type CreatePurchaseItemInput = z.infer<typeof createPurchaseItemSchema>;
export type UpdatePurchaseItemInput = z.infer<typeof updatePurchaseItemSchema>;

// --- payment options --------------------------------------------------------------

export const paymentMethodSchema = z.enum(["pix", "boleto", "cash", "credit_card", "debit_card"]);

export const createPaymentOptionSchema = z
  .object({
    purchaseItemId: z.string().uuid(),
    paymentMethod: paymentMethodSchema,
    cardId: z.string().uuid().nullish(),
    /** Major units; the one-shot cash price, when this option has one. */
    cashPrice: z.coerce.number().nonnegative().nullish(),
    installments: z.coerce.number().int().positive().nullish(),
    /** Major units. */
    installmentAmount: z.coerce.number().nonnegative().nullish(),
    /** Major units; the total the plan costs end to end. */
    totalCost: z.coerce.number().nonnegative("Total cost must not be negative"),
    firstPaymentDate: isoDate.nullish(),
  })
  .refine((data) => data.paymentMethod !== "credit_card" || !!data.cardId, {
    message: "cardId is required for credit_card payment options",
    path: ["cardId"],
  });

export const updatePaymentOptionSchema = z.object({
  paymentMethod: paymentMethodSchema.optional(),
  cardId: z.string().uuid().nullish(),
  cashPrice: z.coerce.number().nonnegative().nullish(),
  installments: z.coerce.number().int().positive().nullish(),
  installmentAmount: z.coerce.number().nonnegative().nullish(),
  totalCost: z.coerce.number().nonnegative("Total cost must not be negative").optional(),
  firstPaymentDate: isoDate.nullish(),
});

export type CreatePaymentOptionInput = z.infer<typeof createPaymentOptionSchema>;
export type UpdatePaymentOptionInput = z.infer<typeof updatePaymentOptionSchema>;

// --- purchase simulation (ad-hoc what-if, driven by searchParams) --------------

export const simulatePurchaseParamsSchema = z
  .object({
    method: paymentMethodSchema,
    /** Major units. */
    amount: z.coerce.number().positive("Amount must be positive"),
    purchaseDate: isoDate.nullish(),
    cardId: z.string().uuid().nullish(),
    installments: z.coerce.number().int().positive().nullish(),
    /** Maps to SimulationContext.maxLastPaymentDate. */
    neededBy: isoDate.nullish(),
  })
  .refine((data) => data.method !== "credit_card" || !!data.cardId, {
    message: "cardId is required for credit_card payment options",
    path: ["cardId"],
  });

export type SimulatePurchaseParamsInput = z.infer<typeof simulatePurchaseParamsSchema>;
