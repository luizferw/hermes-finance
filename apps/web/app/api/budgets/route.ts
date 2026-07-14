import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listBudgetsWithProgress } from "@/modules/budgets/queries";
import { createBudget } from "@/modules/budgets/mutations";
import { createBudgetSchema } from "@/modules/budgets/validators";

export const GET = withUser(async (_req, { user }) => {
  return ok(await listBudgetsWithProgress(user.id));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, createBudgetSchema);
  return ok(await createBudget(input), { status: 201 });
});
