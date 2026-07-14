"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  accounts,
  db,
  importFiles,
  importMappings,
  importRows,
  transactionSplits,
  transactions,
} from "@kosh/db";
import {
  applyMapping,
  computeImportHash,
  findDuplicate,
  findIntraBatchDuplicates,
  guessMapping,
  parseCsv,
  type ColumnMapping,
} from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import { recomputeAccountBalances } from "@/modules/accounts/queries";
import { runRulesOnTransactions } from "@/modules/rules/engine";
import {
  applyMappingSchema,
  commitImportSchema,
  uploadImportSchema,
  type ApplyMappingInput,
  type CommitImportInput,
  type UploadImportInput,
} from "./validators";

function revalidateImports() {
  revalidatePath("/transactions/import");
  revalidatePath("/inbox");
}

/** Step 1: upload — parse the CSV, store raw rows, suggest a mapping. */
export async function uploadImport(input: UploadImportInput) {
  const user = await requireUser();
  const data = uploadImportSchema.parse(input);

  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, data.accountId), eq(accounts.userId, user.id)),
  });
  if (!account) throw new ApiError(404, "not_found", "Account not found.");

  const parsed = parseCsv(data.csvText);
  if (parsed.rows.length === 0) {
    throw new ApiError(422, "empty_file", "The file has a header but no data rows.");
  }
  if (parsed.rows.length > 5000) {
    throw new ApiError(422, "too_many_rows", "Too many rows (max 5,000 per file). Split the statement.");
  }

  const file = await db.transaction(async (trx) => {
    const [created] = await trx
      .insert(importFiles)
      .values({
        userId: user.id,
        accountId: data.accountId,
        fileName: data.fileName,
        status: "uploaded",
        rowCount: parsed.rows.length,
        columns: parsed.headers,
      })
      .returning();

    await trx.insert(importRows).values(
      parsed.rows.map((raw, rowIndex) => ({
        importFileId: created!.id,
        rowIndex,
        raw,
      })),
    );
    return created!;
  });

  await logAudit({
    userId: user.id,
    action: "import.uploaded",
    entityType: "import_file",
    entityId: file.id,
    data: { fileName: data.fileName, rows: parsed.rows.length },
  });
  revalidateImports();

  return {
    importFileId: file.id,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    suggestedMapping: guessMapping(parsed.headers),
    sampleRows: parsed.rows.slice(0, 5),
  };
}

/** Step 2: mapping — parse every row, detect duplicates, ready the preview. */
export async function applyImportMapping(input: ApplyMappingInput) {
  const user = await requireUser();
  const data = applyMappingSchema.parse(input);

  const file = await db.query.importFiles.findFirst({
    where: and(
      eq(importFiles.id, data.importFileId),
      eq(importFiles.userId, user.id),
    ),
    with: { rows: true },
  });
  if (!file) throw new ApiError(404, "not_found", "Import not found.");
  if (!file.accountId) throw new ApiError(409, "no_target_account", "Import has no target account.");
  if (file.status === "committed") throw new ApiError(409, "already_committed", "Import already committed.");
  const mappingAccountId = file.accountId;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, mappingAccountId),
  });
  const currencyCode = account?.currencyCode ?? "INR";
  const mapping = data.mapping as ColumnMapping;

  // Existing transactions on this account for duplicate detection.
  const existing = await db.query.transactions.findMany({
    where: and(
      eq(transactions.accountId, file.accountId),
      eq(transactions.userId, user.id),
    ),
    columns: {
      id: true,
      date: true,
      amountMinor: true,
      importHash: true,
      externalId: true,
    },
  });

  const parsedRows = file.rows
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map((row) => ({
      row,
      parsed: applyMapping(row.raw, mapping, {
        currencyCode,
        dateFormat: data.dateFormat,
      }),
    }));

  const valid = parsedRows.filter(
    (p) => !p.parsed.error && p.parsed.date && p.parsed.amountMinor !== null,
  );
  const intraDupes = findIntraBatchDuplicates(
    mappingAccountId,
    valid.map((p) => ({
      date: p.parsed.date!,
      amountMinor: p.parsed.amountMinor!,
      description: p.parsed.description,
      externalId: p.parsed.externalId,
    })),
  );

  const validIndexOf = new Map(valid.map((p, i) => [p, i]));

  let duplicates = 0;
  let errors = 0;
  await db.transaction(async (trx) => {
    for (const entry of parsedRows) {
      const { row, parsed } = entry;
      const validIndex = validIndexOf.get(entry) ?? -1;
      if (parsed.error || !parsed.date || parsed.amountMinor === null) {
        errors += 1;
        await trx
          .update(importRows)
          .set({
            status: "error",
            parseError: parsed.error ?? "Missing required fields",
            parsedDate: parsed.date,
            parsedAmountMinor: parsed.amountMinor,
            parsedDescription: parsed.description || null,
            parsedExternalId: parsed.externalId,
            duplicateOfTransactionId: null,
          })
          .where(eq(importRows.id, row.id));
        continue;
      }

      const dupe =
        validIndex !== -1 && intraDupes.has(validIndex)
          ? { kind: "exact" as const, transactionId: null }
          : findDuplicate(
              mappingAccountId,
              {
                date: parsed.date,
                amountMinor: parsed.amountMinor,
                description: parsed.description,
                externalId: parsed.externalId,
              },
              existing,
            );

      if (dupe) duplicates += 1;
      await trx
        .update(importRows)
        .set({
          status: dupe ? "duplicate" : "pending",
          parseError: null,
          parsedDate: parsed.date,
          parsedAmountMinor: parsed.amountMinor,
          parsedDescription: parsed.description,
          parsedExternalId: parsed.externalId,
          duplicateOfTransactionId: dupe?.transactionId ?? null,
        })
        .where(eq(importRows.id, row.id));
    }

    await trx
      .update(importFiles)
      .set({ status: "previewed", mapping: data.mapping, dateFormat: data.dateFormat })
      .where(eq(importFiles.id, file.id));

    if (data.saveAsTemplate) {
      await trx.insert(importMappings).values({
        userId: user.id,
        name: data.saveAsTemplate,
        mapping: data.mapping,
        dateFormat: data.dateFormat,
      });
    }
  });

  revalidateImports();
  return {
    total: file.rows.length,
    ready: file.rows.length - duplicates - errors,
    duplicates,
    errors,
  };
}

/** Step 3: commit — create `imported` transactions and run rules. */
export async function commitImport(input: CommitImportInput) {
  const user = await requireUser();
  const data = commitImportSchema.parse(input);

  const file = await db.query.importFiles.findFirst({
    where: and(
      eq(importFiles.id, data.importFileId),
      eq(importFiles.userId, user.id),
    ),
    with: { rows: true },
  });
  if (!file) throw new ApiError(404, "not_found", "Import not found.");
  if (!file.accountId) throw new ApiError(409, "no_target_account", "Import has no target account.");
  if (file.status !== "previewed") {
    throw new ApiError(409, "not_previewed", "Map and preview the file before committing.");
  }

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, file.accountId),
  });
  const currencyCode = account?.currencyCode ?? "INR";
  const excluded = new Set(data.excludedRowIds);

  const accountId = file.accountId;
  // All-or-nothing: create transactions, mirror row status, and seal the file
  // in one transaction so a mid-batch failure can't leave a half-imported file.
  const createdIds = await db.transaction(async (trx) => {
    const [claimed] = await trx
      .update(importFiles)
      .set({ status: "committed", committedAt: new Date() })
      .where(
        and(
          eq(importFiles.id, file.id),
          eq(importFiles.userId, user.id),
          eq(importFiles.status, "previewed"),
        ),
      )
      .returning({ id: importFiles.id });
    if (!claimed) {
      throw new ApiError(409, "already_committed", "Import already committed.");
    }

    const created: string[] = [];
    for (const row of file.rows.sort((a, b) => a.rowIndex - b.rowIndex)) {
      const includable =
        row.status === "pending" &&
        !excluded.has(row.id) &&
        row.parsedDate &&
        row.parsedAmountMinor !== null;

      if (!includable) {
        if (excluded.has(row.id)) {
          await trx
            .update(importRows)
            .set({ status: "rejected" })
            .where(eq(importRows.id, row.id));
        }
        continue;
      }

      const amountMinor = row.parsedAmountMinor!;
      const description = row.parsedDescription ?? "Imported transaction";
      const [tx] = await trx
        .insert(transactions)
        .values({
          userId: user.id,
          accountId,
          type: amountMinor >= 0 ? "income" : "expense",
          status: "imported",
          date: row.parsedDate!,
          amountMinor,
          currencyCode,
          description,
          rawDescription: description,
          narration: row.raw["Narration"] ?? null,
          externalId: row.parsedExternalId,
          importHash: computeImportHash({
            accountId,
            date: row.parsedDate!,
            amountMinor,
            description,
          }),
          importFileId: file.id,
          suspectedDuplicateOfId: row.duplicateOfTransactionId,
        })
        .returning();

      await trx.insert(transactionSplits).values({
        transactionId: tx!.id,
        amountMinor,
        sortOrder: 0,
      });
      await trx
        .update(importRows)
        .set({ status: "approved", transactionId: tx!.id })
        .where(eq(importRows.id, row.id));
      created.push(tx!.id);
    }

    await recomputeAccountBalances([accountId], trx);
    return created;
  });

  // Run automation rules marked run-on-import against the new transactions.
  let rulesApplied = 0;
  if (createdIds.length > 0) {
    rulesApplied = await runRulesOnTransactions(user.id, createdIds, "import");
  }

  await logAudit({
    userId: user.id,
    action: "import.committed",
    entityType: "import_file",
    entityId: file.id,
    data: { created: createdIds.length, rulesApplied },
  });
  revalidateImports();
  revalidatePath("/overview");
  return { created: createdIds.length, rulesApplied };
}

/** Abandon an un-committed import. */
export async function deleteImport(importFileId: string) {
  const user = await requireUser();
  const file = await db.query.importFiles.findFirst({
    where: and(eq(importFiles.id, importFileId), eq(importFiles.userId, user.id)),
  });
  if (!file) throw new ApiError(404, "not_found", "Import not found.");
  if (file.status === "committed") {
    throw new ApiError(409, "committed_immutable", "Committed imports are part of the ledger history.");
  }
  await db.delete(importFiles).where(eq(importFiles.id, importFileId));
  revalidateImports();
}

/** Bulk: rows currently flagged duplicate that the user wants anyway. */
export async function includeDuplicateRows(input: { rowIds: string[] }) {
  const user = await requireUser();
  const rows = await db.query.importRows.findMany({
    where: inArray(importRows.id, input.rowIds),
    with: { importFile: true },
  });
  const owned = rows.filter((r) => r.importFile?.userId === user.id);
  if (owned.length === 0) return;
  await db
    .update(importRows)
    .set({ status: "pending" })
    .where(inArray(importRows.id, owned.map((r) => r.id)));
  revalidateImports();
}
