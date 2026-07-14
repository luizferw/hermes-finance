import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listRules } from "@/modules/rules/queries";
import { createRule } from "@/modules/rules/mutations";
import { createRuleSchema } from "@/modules/rules/validators";

export const GET = withUser(async (_req, { user }) => {
  return ok(await listRules(user.id));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, createRuleSchema);
  return ok(await createRule(input), { status: 201 });
});
