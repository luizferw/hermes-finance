import { z } from "zod";
import { withUser, ok, fail, parseBody } from "@/modules/shared/api";
import { getRule } from "@/modules/rules/queries";
import {
  deleteRule,
  previewStoredRule,
  runRule,
  setRuleActive,
} from "@/modules/rules/mutations";

export const GET = withUser(async (_req, { user, params }) => {
  const rule = await getRule(user.id, params.id!);
  if (!rule) return fail(404, "not_found", "Rule not found.");
  return ok(rule);
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview") }),
  z.object({ action: z.literal("run") }),
  z.object({ action: z.literal("set_active"), isActive: z.boolean() }),
]);

export const POST = withUser(async (req, { params }) => {
  const input = await parseBody(req, actionSchema);
  switch (input.action) {
    case "preview":
      return ok(await previewStoredRule(params.id!));
    case "run":
      return ok(await runRule(params.id!));
    case "set_active":
      await setRuleActive(params.id!, input.isActive);
      return ok({ updated: true });
  }
});

export const DELETE = withUser(async (_req, { params }) => {
  await deleteRule(params.id!);
  return ok({ deleted: true });
});
