import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listConnections } from "@/modules/open-finance/queries";
import { registerConnectionCore } from "@/modules/open-finance/mutations";
import { registerConnectionSchema } from "@/modules/open-finance/validators";

export const GET = withUser(async (_req, { user }) => {
  return ok(await listConnections(user.id));
});

export const POST = withUser(async (req, { user }) => {
  const input = await parseBody(req, registerConnectionSchema);
  return ok(await registerConnectionCore(user.id, input), { status: 201 });
});
