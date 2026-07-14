import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import {
  getInboxItems,
  getRecentlyRejected,
} from "@/modules/transactions/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import { getRuleSuggestions } from "@/modules/rules/queries";
import { PageHeader } from "@/components/app-shell/page-header";
import { InboxClient, type InboxItem } from "./inbox-client";

export const metadata: Metadata = { title: "Inbox" };

function serialize(item: Awaited<ReturnType<typeof getInboxItems>>[number]): InboxItem {
  return {
    id: item.id,
    description: item.description,
    rawDescription: item.rawDescription,
    narration: item.narration,
    date: item.date,
    amountMinor: item.amountMinor,
    currencyCode: item.currencyCode,
    status: item.status,
    type: item.type,
    notes: item.notes,
    upiReference: item.upiReference,
    counterpartyUpiId: item.counterpartyUpiId,
    utrNumber: item.utrNumber,
    externalId: item.externalId,
    account: item.account ? { id: item.account.id, name: item.account.name } : null,
    category: item.category
      ? {
          id: item.category.id,
          name: item.category.name,
          icon: item.category.icon,
          color: item.category.color,
        }
      : null,
    suspectedDuplicateOf: item.suspectedDuplicateOf
      ? {
          id: item.suspectedDuplicateOf.id,
          description: item.suspectedDuplicateOf.description,
          date: item.suspectedDuplicateOf.date,
          amountMinor: item.suspectedDuplicateOf.amountMinor,
        }
      : null,
    importFileName: item.importFile?.fileName ?? null,
  };
}

export default async function InboxPage() {
  const user = await requireUser();
  const [items, rejected, categories, suggestions] = await Promise.all([
    getInboxItems(user.id),
    getRecentlyRejected(user.id),
    listCategories(user.id),
    getRuleSuggestions(user.id),
  ]);

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Review imported and draft transactions before they post"
      />
      <main className="p-4 md:p-6">
        <InboxClient
          items={items.map(serialize)}
          rejected={rejected.map((r) =>
            serialize({ ...r, suspectedDuplicateOf: null, importFile: null }),
          )}
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            color: c.color,
          }))}
          suggestions={suggestions}
        />
      </main>
    </>
  );
}
