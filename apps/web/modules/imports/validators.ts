import { z } from "zod";

export const uploadImportSchema = z.object({
  accountId: z.string().uuid(),
  fileName: z.string().min(1).max(200),
  /** Raw CSV text. 5 MB is far beyond any bank statement. */
  csvText: z.string().min(1).max(5_000_000),
});

export const importFieldSchema = z.enum([
  "date",
  "valueDate",
  "description",
  "amount",
  "debit",
  "credit",
  "externalId",
  "upiReference",
  "utrNumber",
  "narration",
]);

export const applyMappingSchema = z.object({
  importFileId: z.string().uuid(),
  // Partial: a statement only maps the columns it has. Required columns are
  // enforced by the refinement below, not by demanding every field.
  mapping: z
    .partialRecord(importFieldSchema, z.string().min(1))
    .refine((m) => !!m.date && !!m.description && !!(m.amount || m.debit || m.credit), {
      message: "Map at least a date, a description, and an amount (or debit/credit).",
    }),
  dateFormat: z.string().max(20).optional(),
  /** Save this mapping as a reusable template under this name. */
  saveAsTemplate: z.string().max(100).optional(),
});

export const commitImportSchema = z.object({
  importFileId: z.string().uuid(),
  /** Rows to skip (detected duplicates the user agreed to drop, etc.). */
  excludedRowIds: z.array(z.string().uuid()).default([]),
});

export type UploadImportInput = z.infer<typeof uploadImportSchema>;
export type ApplyMappingInput = z.infer<typeof applyMappingSchema>;
export type CommitImportInput = z.infer<typeof commitImportSchema>;
