import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { RepeatIcon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listAccounts } from "@/modules/accounts/queries";
import { listRecurring } from "@/modules/recurring/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import { getUserSettings } from "@/modules/settings/queries";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { NewRecurringDialog } from "./new-recurring-dialog";
import { RecurringList } from "./recurring-list";

export const metadata: Metadata = { title: "Recurring" };

export default async function RecurringPage() {
  const user = await requireUser();
  const [items, accounts, categories, settings] = await Promise.all([
    listRecurring(user.id),
    listAccounts(user.id),
    listCategories(user.id),
    getUserSettings(user.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Recurring money
          </h2>
          <p className="text-sm text-muted-foreground">
            Scheduled income, expenses, and transfers generate inbox drafts.
          </p>
        </div>
        <NewRecurringDialog
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            color: c.color,
          }))}
          defaultCurrency={settings.currencyCode}
        />
      </div>

      {items.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={RepeatIcon} />
            </EmptyMedia>
            <EmptyTitle>No recurring transactions</EmptyTitle>
            <EmptyDescription>
              Add salary, subscriptions, SIPs, or transfers that happen on a
              schedule. Kosh drafts them for review before they post.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <RecurringList
          items={items.map((item) => ({
            id: item.id,
            name: item.name,
            type: item.type,
            accountId: item.accountId,
            transferAccountId: item.transferAccountId,
            categoryId: item.categoryId,
            amountMinor: item.amountMinor,
            currencyCode: item.currencyCode,
            description: item.description,
            interval: item.interval,
            nextRunDate: item.nextRunDate,
            lastRunDate: item.lastRunDate,
            isActive: item.isActive,
            accountName: item.account.name,
            category: item.category,
          }))}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            color: c.color,
          }))}
        />
      )}
    </div>
  );
}
