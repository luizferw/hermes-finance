import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DatabaseIcon,
  Shield01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { getUserSettings } from "@/modules/settings/queries";
import { getSystemHealth } from "@/modules/system/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();
  const [settings, health] = await Promise.all([
    getUserSettings(user.id),
    getSystemHealth(),
  ]);
  const issueCount = health.checks.filter((check) => check.status !== "ok").length;

  return (
    <>
      <PageHeader title="Settings" description="Preferences and self-hosting status" />

      <main className="grid gap-5 p-4 md:p-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={Settings01Icon} className="size-4" />
              Preferences
            </CardTitle>
            <CardDescription>
              Display settings used by dashboards, reports, and imports.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SettingsForm settings={settings} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={DatabaseIcon} className="size-4" />
                System health
              </CardTitle>
              <CardDescription>
                Database, migrations, jobs, storage, and auth configuration.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Checks</span>
                <Badge variant={issueCount === 0 ? "secondary" : "destructive"}>
                  {issueCount === 0 ? "All ok" : `${issueCount} issue${issueCount === 1 ? "" : "s"}`}
                </Badge>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/health">Open health view</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={DatabaseIcon} className="size-4" />
                Export your data
              </CardTitle>
              <CardDescription>
                Download your own data anytime. Your money is yours.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href="/api/export/transactions" download>
                  Transactions (CSV)
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href="/api/export/data" download>
                  All data (JSON)
                </a>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={Shield01Icon} className="size-4" />
                Privacy
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Kosh is self-hosted and keeps analytics, tracking pixels, and
              external telemetry out of the app surface.
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  );
}
