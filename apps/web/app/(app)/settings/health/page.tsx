import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Clock01Icon,
  DatabaseIcon,
  PulseIcon,
} from "@hugeicons/core-free-icons";
import { getSystemHealth, type CheckStatus } from "@/modules/system/queries";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "System Health" };

export default async function HealthPage() {
  const health = await getSystemHealth();
  const issueCount = health.checks.filter((check) => check.status !== "ok").length;

  return (
    <>
      <PageHeader title="System health" description="Self-hosting checks and job status">
        <Button asChild variant="outline" size="sm">
          <Link href="/settings">Settings</Link>
        </Button>
      </PageHeader>

      <main className="space-y-5 p-4 md:p-6">
        <section className="grid gap-3 md:grid-cols-3">
          <Card className="gap-1.5 px-5 py-4">
            <p className="micro-label">Version</p>
            <p className="font-amount text-xl">{health.version}</p>
            <p className="text-xs text-muted-foreground">{health.environment}</p>
          </Card>
          <Card className="gap-1.5 px-5 py-4">
            <p className="micro-label">Checks</p>
            <p className="font-amount text-xl">
              {health.checks.length - issueCount}/{health.checks.length}
            </p>
            <p className="text-xs text-muted-foreground">
              {issueCount === 0 ? "All passing" : `${issueCount} need attention`}
            </p>
          </Card>
          <Card className="gap-1.5 px-5 py-4">
            <p className="micro-label">Jobs</p>
            <p className="font-amount text-xl">{health.jobs.length}</p>
            <p className="text-xs text-muted-foreground">Registered background jobs</p>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={PulseIcon} className="size-4" />
              Checks
            </CardTitle>
            <CardDescription>
              Readiness checks for this Kosh deployment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              {health.checks.map((check) => (
                <div
                  key={check.id}
                  className="rounded-lg border border-ledger bg-muted/20 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{check.label}</p>
                    <StatusBadge status={check.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {check.detail}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={DatabaseIcon} className="size-4" />
              Background jobs
            </CardTitle>
            <CardDescription>
              pg-boss workers update this table after each run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {health.jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                No jobs have registered yet.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <div className="font-medium">{job.name}</div>
                        {job.description && (
                          <div className="text-xs text-muted-foreground">
                            {job.description}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {job.schedule ?? "manual"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={
                            job.lastStatus === "error"
                              ? "error"
                              : job.lastStatus === "ok"
                                ? "ok"
                                : "warn"
                          }
                        />
                        {job.lastError && (
                          <p className="mt-1 text-xs text-destructive">
                            {job.lastError}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {job.lastRunAt ? job.lastRunAt.toLocaleString("en-IN") : "Never"}
                      </TableCell>
                      <TableCell className="text-right font-amount">
                        {job.lastDurationMs ? `${job.lastDurationMs}ms` : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}

function StatusBadge({ status }: { status: CheckStatus }) {
  const labels: Record<CheckStatus, string> = {
    ok: "OK",
    warn: "Warning",
    error: "Error",
  };
  const className =
    status === "ok"
      ? "bg-success/10 text-success"
      : status === "warn"
        ? "bg-warning/15 text-warning-foreground dark:text-warning"
        : "bg-destructive/10 text-destructive";
  return (
    <Badge className={className}>
      <HugeiconsIcon
        icon={status === "ok" ? CheckmarkCircle02Icon : Clock01Icon}
        className="size-3"
      />
      {labels[status]}
    </Badge>
  );
}
