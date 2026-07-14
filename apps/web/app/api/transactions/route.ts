import { withUser, ok, parseBody, parseQuery } from "@/modules/shared/api";
import { listTransactions } from "@/modules/transactions/queries";
import { createTransaction } from "@/modules/transactions/mutations";
import {
  createTransactionSchema,
  listTransactionsSchema,
} from "@/modules/transactions/validators";

export const GET = withUser(async (req, { user }) => {
  const input = parseQuery(req, listTransactionsSchema);
  return ok(await listTransactions(user.id, input));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, createTransactionSchema);
  const tx = await createTransaction(input);
  return ok(tx, { status: 201 });
});
