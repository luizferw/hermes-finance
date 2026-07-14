import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listImportFiles } from "@/modules/imports/queries";
import { uploadImport } from "@/modules/imports/mutations";
import { uploadImportSchema } from "@/modules/imports/validators";

export const GET = withUser(async (_req, { user }) => {
  return ok(await listImportFiles(user.id));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, uploadImportSchema);
  return ok(await uploadImport(input), { status: 201 });
});
