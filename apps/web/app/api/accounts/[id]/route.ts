import { withUser, ok, fail, parseBody } from "@/modules/shared/api";
import {
  getAccount,
  getAccountBalanceHistory,
} from "@/modules/accounts/queries";
import { archiveAccount, updateAccount } from "@/modules/accounts/mutations";
import { updateAccountSchema } from "@/modules/accounts/validators";

export const GET = withUser(async (_req, { user, params }) => {
  const account = await getAccount(user.id, params.id!);
  if (!account) return fail(404, "not_found", "Account not found.");
  const balances = await getAccountBalanceHistory(user.id, params.id!);
  return ok({ ...account, balanceHistory: balances });
});

export const PATCH = withUser(async (req, { params }) => {
  const input = await parseBody(req, updateAccountSchema);
  await updateAccount(params.id!, input);
  return ok({ updated: true });
});

export const DELETE = withUser(async (_req, { params }) => {
  await archiveAccount(params.id!);
  return ok({ archived: true });
});
