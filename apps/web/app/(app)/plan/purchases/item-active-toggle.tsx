"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setPurchaseItemActive } from "@/modules/finance/mutations";
import { Switch } from "@/components/ui/switch";

/**
 * Sets a purchase item aside, or brings it back, without deleting it. An
 * inactive item stays listed but counts toward neither the plan's totals nor
 * its projection. Shared by the plan list and the plan detail page.
 */
export function PurchaseItemActiveToggle({
  item,
}: {
  item: { id: string; name: string; isActive: boolean };
}) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  // Flips immediately so the switch does not lag the click; the refresh then
  // brings the totals and the horizon in line with it.
  const [optimistic, setOptimistic] = React.useOptimistic(item.isActive);

  function toggle(next: boolean) {
    startTransition(async () => {
      setOptimistic(next);
      try {
        await setPurchaseItemActive(item.id, { isActive: next });
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Could not update ${item.name}`);
      }
    });
  }

  return (
    <Switch
      size="sm"
      checked={optimistic}
      onCheckedChange={toggle}
      disabled={isPending}
      aria-label={optimistic ? `Set ${item.name} aside` : `Include ${item.name} again`}
      title={optimistic ? "Included in the plan" : "Set aside — not counted"}
    />
  );
}
