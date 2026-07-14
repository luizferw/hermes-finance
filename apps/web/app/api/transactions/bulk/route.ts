import { z } from "zod";
import { withUser, ok, parseBody } from "@/modules/shared/api";
import {
  approveTransactions,
  bulkCategorize,
  rejectTransactions,
  restoreTransactions,
} from "@/modules/transactions/mutations";

const bulkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), ids: z.array(z.string().uuid()).min(1) }),
  z.object({ action: z.literal("reject"), ids: z.array(z.string().uuid()).min(1) }),
  z.object({ action: z.literal("restore"), ids: z.array(z.string().uuid()).min(1) }),
  z.object({
    action: z.literal("categorize"),
    ids: z.array(z.string().uuid()).min(1),
    categoryId: z.string().uuid(),
  }),
]);

export const POST = withUser(async (req) => {
  const input = await parseBody(req, bulkActionSchema);
  switch (input.action) {
    case "approve":
      return ok(await approveTransactions({ ids: input.ids }));
    case "reject":
      return ok(await rejectTransactions({ ids: input.ids }));
    case "restore":
      return ok(await restoreTransactions({ ids: input.ids }));
    case "categorize":
      return ok(
        await bulkCategorize({ ids: input.ids, categoryId: input.categoryId }),
      );
  }
});
