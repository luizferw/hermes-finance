import { withUser, ok } from "@/modules/shared/api";
import { syncConnection } from "@/modules/open-finance/sync";

/**
 * Sync one connection on demand.
 *
 * There is no webhook counterpart: Pluggy's webhooks carry no signature, and
 * this deployment is not reachable from the internet anyway, so collection is
 * driven by the scheduled job and by this endpoint.
 */
export const POST = withUser(async (_req, { user, params }) => {
  return ok(await syncConnection(user.id, params.id!, { trigger: "manual" }));
});
