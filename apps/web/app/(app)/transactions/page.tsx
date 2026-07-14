import type { Metadata } from "next";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Upload01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listAccounts } from "@/modules/accounts/queries";
import { listCategories, listTags } from "@/modules/taxonomy/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { TransactionsClient } from "./transactions-client";

export const metadata: Metadata = { title: "Transactions" };

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const [accounts, categories, tags] = await Promise.all([
    listAccounts(user.id),
    listCategories(user.id),
    listTags(user.id),
  ]);

  return (
    <>
      <PageHeader title="Transactions" description="The full ledger, searchable">
        <Button asChild size="sm" variant="outline" className="h-8">
          <Link href="/transactions/import">
            <HugeiconsIcon icon={Upload01Icon} />
            <span className="hidden sm:inline">Import CSV</span>
          </Link>
        </Button>
      </PageHeader>
      {/* No padded <main>: the client renders its own tier-2 strip full-bleed
          (sticky under the header) and pads its body itself. */}
      <TransactionsClient
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          currencyCode: a.currencyCode,
        }))}
        categories={categories.map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
        }))}
        tags={tags.map((t) => ({ id: t.id, name: t.name }))}
        initialNewOpen={params.new === "1"}
        initialStatus={typeof params.status === "string" ? params.status : undefined}
        initialFocusId={typeof params.focus === "string" ? params.focus : undefined}
      />
    </>
  );
}
