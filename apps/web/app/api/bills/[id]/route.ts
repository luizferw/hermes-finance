import { z } from "zod";
import { withUser, ok, parseBody } from "@/modules/shared/api";
import { deleteBill, markBillPaid, updateBill } from "@/modules/bills/mutations";
import { updateBillSchema } from "@/modules/bills/validators";

export const PATCH = withUser(async (req, { params }) => {
  const input = await parseBody(req, updateBillSchema);
  await updateBill(params.id!, input);
  return ok({ updated: true });
});

const paySchema = z.object({
  action: z.literal("mark_paid"),
  transactionId: z.string().uuid().optional(),
});

export const POST = withUser(async (req, { params }) => {
  const input = await parseBody(req, paySchema);
  await markBillPaid({ billId: params.id!, transactionId: input.transactionId });
  return ok({ paid: true });
});

export const DELETE = withUser(async (_req, { params }) => {
  await deleteBill(params.id!);
  return ok({ deleted: true });
});
