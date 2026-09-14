import { withUser, ok, fail, parseBody } from "@/modules/shared/api";
import { createConnectTokenCore } from "@/modules/open-finance/mutations";
import { connectTokenSchema } from "@/modules/open-finance/validators";

/**
 * Mint a short-lived credential for Pluggy's widget.
 *
 * The token is created server-side because it needs the deployment's API key,
 * which never reaches the browser. When it carries a `connectionId` the token is
 * scoped to that Item — and the connection is checked against the session user
 * first, so a token can never be minted for someone else's bank.
 */
export const POST = withUser(async (req, { user }) => {
  const input = await parseBody(req, connectTokenSchema);
  const token = await createConnectTokenCore(user.id, input);
  if (!token) return fail(503, "open_finance_disabled", "Open Finance is not configured.");
  return ok({ accessToken: token.accessToken, itemId: token.itemId });
});
