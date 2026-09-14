import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BankIcon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import {
  isOpenFinanceEnabled,
  listConnections,
  listLinkTargets,
  listSyncRuns,
} from "@/modules/open-finance/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConnectionsPanel } from "./connections-panel";
import { SyncRunsTable } from "./sync-runs-table";

export const metadata: Metadata = { title: "Open Finance" };

export default async function OpenFinancePage() {
  const user = await requireUser();
  const enabled = isOpenFinanceEnabled();
  const [connections, linkTargets, runs] = await Promise.all([
    listConnections(user.id),
    listLinkTargets(user.id),
    listSyncRuns(user.id),
  ]);

  return (
    <>
      <PageHeader
        title="Open Finance"
        description="Read your banks and cards through Pluggy"
      />

      <main className="grid gap-5 p-4 md:p-6">
        {!enabled ? (
          <Alert>
            <AlertTitle>Open Finance is switched off</AlertTitle>
            <AlertDescription>
              Set <code>PLUGGY_ENABLED=true</code> along with{" "}
              <code>PLUGGY_CLIENT_ID</code> and <code>PLUGGY_CLIENT_SECRET</code> in the
              root <code>.env</code>, then restart the app. The credentials come from an
              application in the Pluggy dashboard.
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={BankIcon} className="size-4" />
              Connections
            </CardTitle>
            <CardDescription>
              Hermes never creates a bank connection. Connect your banks at{" "}
              <a
                className="underline underline-offset-4"
                href="https://meu.pluggy.ai"
                target="_blank"
                rel="noreferrer"
              >
                meu.pluggy.ai
              </a>
              , copy each Item ID from the Pluggy dashboard, and paste it here. Everything
              below is read-only: no payment is ever initiated.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectionsPanel
              connections={connections}
              linkTargets={linkTargets}
              enabled={enabled}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent syncs</CardTitle>
            <CardDescription>
              What each run saw, created and left for you to judge.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SyncRunsTable runs={runs} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
