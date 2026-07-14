import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, importFiles, importMappings, importRows } from "@kosh/db";

export async function listImportFiles(userId: string) {
  return db.query.importFiles.findMany({
    where: eq(importFiles.userId, userId),
    with: { account: { columns: { id: true, name: true } } },
    orderBy: [desc(importFiles.createdAt)],
    limit: 30,
  });
}

export async function getImportFile(userId: string, id: string) {
  return db.query.importFiles.findFirst({
    where: and(eq(importFiles.id, id), eq(importFiles.userId, userId)),
    with: {
      account: { columns: { id: true, name: true, currencyCode: true } },
      rows: {
        orderBy: [asc(importRows.rowIndex)],
        with: {
          duplicateOfTransaction: {
            columns: { id: true, description: true, date: true, amountMinor: true },
          },
        },
      },
    },
  });
}

export async function listImportMappings(userId: string) {
  return db.query.importMappings.findMany({
    where: eq(importMappings.userId, userId),
    orderBy: [desc(importMappings.updatedAt)],
  });
}
