"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { accountBalances, accounts, db, transactions } from "@kosh/db";
import { majorToMinor, todayIso } from "@kosh/domain";
import { requireUser } from "@/lib/session";
import { ApiError } from "@/modules/shared/api";
import { logAudit } from "@/modules/shared/audit";
import {
  createAccountSchema,
  updateAccountSchema,
  type CreateAccountInput,
  type UpdateAccountInput,
} from "./validators";

export async function createAccount(input: CreateAccountInput) {
  const user = await requireUser();
  const data = createAccountSchema.parse(input);
  const openingBalanceMinor = majorToMinor(data.openingBalance, data.currencyCode);
  const openingDate = data.openingBalanceDate ?? todayIso();

  const account = await db.transaction(async (trx) => {
    const [created] = await trx
      .insert(accounts)
      .values({
        userId: user.id,
        name: data.name,
        type: data.type,
        currencyCode: data.currencyCode,
        institution: data.institution,
        accountNumberMask: data.accountNumberMask,
        upiId: data.upiId,
        openingBalanceMinor,
        openingBalanceDate: openingDate,
        currentBalanceMinor: openingBalanceMinor,
        limitMinor:
          data.limit !== undefined ? majorToMinor(data.limit, data.currencyCode) : null,
        includeInNetWorth: data.includeInNetWorth,
        notes: data.notes,
      })
      .returning();

    await trx.insert(accountBalances).values({
      accountId: created!.id,
      date: todayIso(),
      balanceMinor: openingBalanceMinor,
      currencyCode: data.currencyCode,
    });
    return created!;
  });

  await logAudit({
    userId: user.id,
    action: "account.created",
    entityType: "account",
    entityId: account.id,
    data: { name: data.name, type: data.type },
  });
  revalidatePath("/accounts");
  return account;
}

export async function updateAccount(accountId: string, input: UpdateAccountInput) {
  const user = await requireUser();
  const data = updateAccountSchema.parse(input);

  const existing = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, accountId), eq(accounts.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Account not found.");

  const currency = data.currencyCode ?? existing.currencyCode;
  await db
    .update(accounts)
    .set({
      name: data.name ?? existing.name,
      institution: data.institution ?? existing.institution,
      accountNumberMask: data.accountNumberMask ?? existing.accountNumberMask,
      upiId: data.upiId ?? existing.upiId,
      includeInNetWorth: data.includeInNetWorth ?? existing.includeInNetWorth,
      isArchived: data.isArchived ?? existing.isArchived,
      notes: data.notes ?? existing.notes,
      limitMinor:
        data.limit !== undefined ? majorToMinor(data.limit, currency) : existing.limitMinor,
    })
    .where(eq(accounts.id, accountId));

  await logAudit({
    userId: user.id,
    action: "account.updated",
    entityType: "account",
    entityId: accountId,
    data: { changed: Object.keys(data) },
  });
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
}

/** Archive instead of delete when the account has transactions. */
export async function archiveAccount(accountId: string) {
  const user = await requireUser();
  const existing = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, accountId), eq(accounts.userId, user.id)),
  });
  if (!existing) throw new ApiError(404, "not_found", "Account not found.");

  const hasTransactions = await db.query.transactions.findFirst({
    where: eq(transactions.accountId, accountId),
    columns: { id: true },
  });

  if (hasTransactions) {
    await db
      .update(accounts)
      .set({ isArchived: true })
      .where(eq(accounts.id, accountId));
  } else {
    await db.delete(accounts).where(eq(accounts.id, accountId));
  }

  await logAudit({
    userId: user.id,
    action: hasTransactions ? "account.archived" : "account.deleted",
    entityType: "account",
    entityId: accountId,
    data: { name: existing.name },
  });
  revalidatePath("/accounts");
}
