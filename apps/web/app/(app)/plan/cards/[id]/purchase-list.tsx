"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { deleteCardPurchase } from "@/modules/finance/mutations";
import { formatDate, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface CardPurchaseRow {
  id: string;
  purchaseDate: string;
  description: string;
  merchant: string | null;
  totalAmountMinor: number;
  totalInstallments: number | null;
}

/**
 * Registered purchases, with the only way to take one back.
 *
 * Deleting here removes the expense *and* the installments it scheduled.
 * Deleting the same purchase from the transactions screen does not: that is a
 * soft delete, which would hide the expense while its installments kept landing
 * on future statements.
 */
export function CardPurchaseList({
  purchases,
  currencyCode,
}: {
  purchases: CardPurchaseRow[];
  currencyCode: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function remove(purchase: CardPurchaseRow) {
    setBusyId(purchase.id);
    startTransition(async () => {
      try {
        await deleteCardPurchase(purchase.id);
        toast.success(`${purchase.description} removed`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not remove the purchase");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <ul className="divide-y divide-dashed">
      {purchases.map((purchase) => (
        <li
          key={purchase.id}
          className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{purchase.description}</p>
            <p className="text-xs text-muted-foreground">
              {formatDate(purchase.purchaseDate)}
              {purchase.merchant && ` · ${purchase.merchant}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {purchase.totalInstallments && purchase.totalInstallments > 1 && (
              <Badge variant="outline" className="text-[10px]">
                {purchase.totalInstallments}x
              </Badge>
            )}
            <span className="font-amount text-sm tabular-nums">
              {formatMoney(purchase.totalAmountMinor, currencyCode)}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={isPending && busyId === purchase.id}
              onClick={() => remove(purchase)}
              aria-label={`Remove ${purchase.description}`}
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-4 text-muted-foreground" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
