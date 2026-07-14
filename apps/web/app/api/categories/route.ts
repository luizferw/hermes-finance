import { z } from "zod";
import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listCategories } from "@/modules/taxonomy/queries";
import { createCategory } from "@/modules/taxonomy/mutations";

const createSchema = z.object({
  name: z.string().min(1).max(60),
  icon: z.string().max(40).optional(),
  color: z.string().max(40).optional(),
});

export const GET = withUser(async (_req, { user }) => {
  return ok(await listCategories(user.id));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, createSchema);
  return ok(await createCategory(input), { status: 201 });
});
