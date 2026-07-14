import { withUser, ok } from "@/modules/shared/api";
import { getSystemHealth } from "@/modules/system/queries";

export function HEAD() {
  return new Response(null, { status: 200 });
}

export const GET = withUser(async () => {
  return ok(await getSystemHealth());
});
