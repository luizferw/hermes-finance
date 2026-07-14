import { z } from "zod";
import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listTags } from "@/modules/taxonomy/queries";
import { createTag } from "@/modules/taxonomy/mutations";

const createSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(40).optional(),
});

export const GET = withUser(async (_req, { user }) => {
  return ok(await listTags(user.id));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, createSchema);
  return ok(await createTag(input), { status: 201 });
});
