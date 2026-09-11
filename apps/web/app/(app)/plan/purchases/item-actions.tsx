"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, MoreVerticalIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { deletePurchaseItem } from "@/modules/finance/mutations";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditPurchaseItemDialog, type EditablePurchaseItem } from "./edit-item-dialog";

/** Edit/delete for one purchase item, shared by the plan list and the plan detail page. */
export function PurchaseItemActions({
  item,
  currencyCode,
  accounts,
}: {
  item: EditablePurchaseItem;
  currencyCode: string;
  accounts: Array<{ id: string; name: string; type: string }>;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  function remove() {
    startTransition(async () => {
      try {
        await deletePurchaseItem(item.id);
        toast.success(`${item.name} deleted`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete the item");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" disabled={isPending}>
            <HugeiconsIcon icon={MoreVerticalIcon} className="size-4" />
            <span className="sr-only">Item actions</span>
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
      <EditPurchaseItemDialog
        item={item}
        currencyCode={currencyCode}
        accounts={accounts}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </>
  );
}
