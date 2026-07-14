import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { listAccounts } from "@/modules/accounts/queries";
import { listImportFiles, listImportMappings } from "@/modules/imports/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "Import CSV" };

export default async function ImportPage() {
  const user = await requireUser();
  const [accounts, mappings, files] = await Promise.all([
    listAccounts(user.id),
    listImportMappings(user.id),
    listImportFiles(user.id),
  ]);

  return (
    <>
      <PageHeader
        title="Import"
        description="Bank statement CSV → mapped, deduplicated, reviewed"
      />
      <main className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
        <ImportWizard
          accounts={accounts
            .filter((a) => !a.isArchived)
            .map((a) => ({ id: a.id, name: a.name, currencyCode: a.currencyCode }))}
          templates={mappings.map((m) => ({
            id: m.id,
            name: m.name,
            mapping: m.mapping,
            dateFormat: m.dateFormat,
          }))}
        />

        {files.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="micro-label">Recent imports</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-dashed">
                {files.map((file) => (
                  <li
                    key={file.id}
                    className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-amount text-sm">{file.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        {file.account?.name ?? "No account"} ·{" "}
                        {formatDate(file.createdAt.toISOString().slice(0, 10))} ·{" "}
                        {file.rowCount} rows
                      </p>
                    </div>
                    <Badge
                      variant={file.status === "committed" ? "secondary" : "outline"}
                      className="capitalize"
                    >
                      {file.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}
