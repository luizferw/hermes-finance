import { withUser, ok, parseBody } from "@/modules/shared/api";
import { applyImportMapping } from "@/modules/imports/mutations";
import { applyMappingSchema } from "@/modules/imports/validators";

export const POST = withUser(async (req, { params }) => {
  const body = await parseBody(
    req,
    applyMappingSchema.omit({ importFileId: true }),
  );
  return ok(await applyImportMapping({ ...body, importFileId: params.id! }));
});
