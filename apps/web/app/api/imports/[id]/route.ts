import { withUser, ok, fail } from "@/modules/shared/api";
import { getImportFile } from "@/modules/imports/queries";
import { deleteImport } from "@/modules/imports/mutations";

export const GET = withUser(async (_req, { user, params }) => {
  const file = await getImportFile(user.id, params.id!);
  if (!file) return fail(404, "not_found", "Import not found.");
  return ok(file);
});

export const DELETE = withUser(async (_req, { params }) => {
  await deleteImport(params.id!);
  return ok({ deleted: true });
});
