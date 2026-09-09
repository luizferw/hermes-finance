import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Invoice01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listBills } from "@/modules/bills/queries";
import { listAccounts } from "@/modules/accounts/queries";
import { listCategories } from "@/modules/taxonomy/queries";
import { getUserSettings } from "@/modules/settings/queries";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { BillList } from "./bill-list";
import { NewBillDialog } from "./new-bill-dialog";

export const metadata: Metadata = { title: "Bills" };

export default async function BillsPage() {
  const user = await requireUser();
  const [bills, accounts, categories, settings] = await Promise.all([
    listBills(user.id),
    listAccounts(user.id),
    listCategories(user.id),
    getUserSettings(user.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Bills & subscriptions
          </h2>
          <p className="text-sm text-muted-foreground">
            Expected payments with due dates — Kosh flags what’s overdue.
          </p>
        </div>
        <NewBillDialog
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            color: c.color,
          }))}
          defaultCurrency={settings.currencyCode}
        />
      </div>

      {bills.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Invoice01Icon} />
            </EmptyMedia>
            <EmptyTitle>No bills tracked</EmptyTitle>
            <EmptyDescription>
              Rent, electricity, Netflix, insurance — add what you expect to
              pay and when, and the dashboard will warn you before due dates.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <BillList
          bills={bills.map(({ bill, state, daysUntilDue }) => ({
            id: bill.id,
            name: bill.name,
            expectedAmountMinor: bill.expectedAmountMinor,
            currencyCode: bill.currencyCode,
            recurrence: bill.recurrence,
            nextDueDate: bill.nextDueDate,
            lastPaidDate: bill.lastPaidDate,
            isActive: bill.isActive,
            accountName: bill.account?.name ?? null,
            category: bill.category,
            state,
            daysUntilDue,
          }))}
        />
      )}
    </div>
  );
}
