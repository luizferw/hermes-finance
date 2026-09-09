import type { Metadata } from "next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Shield01Icon } from "@hugeicons/core-free-icons";
import { requireUser } from "@/lib/session";
import { listFinancialReserves } from "@/modules/finance/queries";
import { getUserSettings } from "@/modules/settings/queries";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { NewReserveDialog } from "./new-reserve-dialog";
import { ReserveList } from "./reserve-list";

export const metadata: Metadata = { title: "Reserves" };

export default async function ReservesPage() {
  const user = await requireUser();
  const [reserves, settings] = await Promise.all([
    listFinancialReserves(user.id),
    getUserSettings(user.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Protected reserves</h2>
          <p className="text-sm text-muted-foreground">
            Hard reserves are a floor safe-to-spend never crosses. Soft ones
            only warn when a simulated purchase would eat into them.
          </p>
        </div>
        <NewReserveDialog defaultCurrency={settings.currencyCode} />
      </div>

      {reserves.length === 0 ? (
        <Empty className="border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Shield01Icon} />
            </EmptyMedia>
            <EmptyTitle>No reserves configured</EmptyTitle>
            <EmptyDescription>
              Without a hard reserve, safe-to-spend treats every projected
              amount as spendable — add one to protect what should not be touched.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ReserveList
          reserves={reserves.map((reserve) => ({
            id: reserve.id,
            name: reserve.name,
            kind: reserve.kind,
            amountMinor: reserve.amountMinor,
            currencyCode: reserve.currencyCode,
            isActive: reserve.isActive,
          }))}
        />
      )}
    </div>
  );
}
