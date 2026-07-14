import { withUser, ok, parseBody } from "@/modules/shared/api";
import { commitImport } from "@/modules/imports/mutations";
import { commitImportSchema } from "@/modules/imports/validators";

export const POST = withUser(async (req, { params }) => {
  const body = await parseBody(
    req,
    commitImportSchema.omit({ importFileId: true }),
  );
  return ok(await commitImport({ ...body, importFileId: params.id! }));
});
