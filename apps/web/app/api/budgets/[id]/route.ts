import { withUser, ok, parseBody } from "@/modules/shared/api";
import { archiveBudget, updateBudget } from "@/modules/budgets/mutations";
import { updateBudgetSchema } from "@/modules/budgets/validators";

export const PATCH = withUser(async (req, { params }) => {
  const input = await parseBody(req, updateBudgetSchema);
  await updateBudget(params.id!, input);
  return ok({ updated: true });
});

export const DELETE = withUser(async (_req, { params }) => {
  await archiveBudget(params.id!);
  return ok({ archived: true });
});
