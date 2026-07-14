import { withUser, ok, fail, parseBody } from "@/modules/shared/api";
import { getTransaction } from "@/modules/transactions/queries";
import {
  deleteTransaction,
  updateTransaction,
} from "@/modules/transactions/mutations";
import { updateTransactionSchema } from "@/modules/transactions/validators";

export const GET = withUser(async (_req, { user, params }) => {
  const tx = await getTransaction(user.id, params.id!);
  if (!tx) return fail(404, "not_found", "Transaction not found.");
  return ok(tx);
});

export const PATCH = withUser(async (req, { params }) => {
  const input = await parseBody(req, updateTransactionSchema);
  await updateTransaction(params.id!, input);
  return ok({ updated: true });
});

export const DELETE = withUser(async (_req, { params }) => {
  await deleteTransaction(params.id!);
  return ok({ deleted: true });
});
