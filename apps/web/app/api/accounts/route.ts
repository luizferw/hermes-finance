import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listAccounts } from "@/modules/accounts/queries";
import { createAccount } from "@/modules/accounts/mutations";
import { createAccountSchema } from "@/modules/accounts/validators";

export const GET = withUser(async (_req, { user }) => {
  return ok(await listAccounts(user.id));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, createAccountSchema);
  const account = await createAccount(input);
  return ok(account, { status: 201 });
});
