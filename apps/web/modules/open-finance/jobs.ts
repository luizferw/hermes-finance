import "server-only";
import { syncAllConnections } from "./sync";

/**
 * The scheduled sync.
 *
 * Pluggy refreshes each connection once a day on its own side and explicitly
 * discourages clients from driving that; this job only collects what is already
 * there. Jobs in this app carry no payload and no user, so the fan-out across
 * users happens inside `syncAllConnections`.
 */
export async function runScheduledOpenFinanceSync() {
  return syncAllConnections({ trigger: "scheduled" });
}
