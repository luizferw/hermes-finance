import { withUser, ok, parseBody } from "@/modules/shared/api";
import { listBills } from "@/modules/bills/queries";
import { createBill } from "@/modules/bills/mutations";
import { createBillSchema } from "@/modules/bills/validators";

export const GET = withUser(async (_req, { user }) => {
  return ok(await listBills(user.id));
});

export const POST = withUser(async (req) => {
  const input = await parseBody(req, createBillSchema);
  return ok(await createBill(input), { status: 201 });
});
