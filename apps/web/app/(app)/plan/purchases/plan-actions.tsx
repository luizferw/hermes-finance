"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, MoreVerticalIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { deletePurchasePlan } from "@/modules/finance/mutations";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditPurchasePlanDialog, type EditablePurchasePlan } from "./edit-plan-dialog";

/**
 * Edit/delete for one purchase plan. The list page just refreshes after a
 * delete; the detail page has nowhere left to render once its own plan is
 * gone, so it navigates back to the list instead.
 */
export function PurchasePlanActions({
  plan,
  redirectAfterDelete,
}: {
  plan: EditablePurchasePlan;
  redirectAfterDelete?: boolean;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  function remove() {
    startTransition(async () => {
      try {
        await deletePurchasePlan(plan.id);
        toast.success(`${plan.name} deleted`);
        if (redirectAfterDelete) router.push("/plan/purchases");
        else router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete the plan");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" disabled={isPending}>
            <HugeiconsIcon icon={MoreVerticalIcon} />
            <span className="sr-only">Plan actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <HugeiconsIcon icon={PencilEdit02Icon} />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={remove}>
            <HugeiconsIcon icon={Delete02Icon} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EditPurchasePlanDialog plan={plan} open={editOpen} onOpenChange={setEditOpen} />
    </>
  );
}
