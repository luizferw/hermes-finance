"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Delete02Icon,
  MoreVerticalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { deletePaymentOption, selectPaymentOption } from "@/modules/finance/mutations";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditPaymentOptionDialog, type EditablePaymentOption } from "./edit-payment-option-dialog";
import { NewPaymentOptionDialog, PAYMENT_METHODS } from "./new-payment-option-dialog";

const PAYMENT_METHOD_LABEL: Record<EditablePaymentOption["paymentMethod"], string> = Object.fromEntries(
  PAYMENT_METHODS.map((option) => [option.value, option.label]),
) as Record<EditablePaymentOption["paymentMethod"], string>;

/**
 * The stored options behind an item's comparison. This only manages the
 * records themselves — the comparison rendered elsewhere on the page is the
 * engine's output, untouched here.
 */
export function PaymentOptionsSection({
  purchaseItemId,
  currencyCode,
  options,
  cards,
  selectedPaymentOptionId,
}: {
  purchaseItemId: string;
  currencyCode: string;
  options: EditablePaymentOption[];
  cards: Array<{ id: string; name: string }>;
  /** The option this item is actually being paid by, if any has been chosen. */
  selectedPaymentOptionId: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<EditablePaymentOption | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function remove(option: EditablePaymentOption) {
    setBusyId(option.id);
    startTransition(async () => {
      try {
        await deletePaymentOption(option.id);
        toast.success("Payment option deleted");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not delete the payment option");
      } finally {
        setBusyId(null);
      }
    });
  }

  function choose(option: EditablePaymentOption) {
    setBusyId(option.id);
    startTransition(async () => {
      try {
        await selectPaymentOption(purchaseItemId, { paymentOptionId: option.id });
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not set the chosen option");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-dashed border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">Payment options</h4>
        <NewPaymentOptionDialog
          purchaseItemId={purchaseItemId}
          currencyCode={currencyCode}
          cards={cards}
        />
      </div>

      {options.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No payment options recorded yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-dashed">
          {options.map((option) => {
            const isChosen = option.id === selectedPaymentOptionId;
            return (
              <li
                key={option.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md py-1.5 first:pt-0 last:pb-0",
                  isChosen && "bg-primary/5 px-1.5",
                )}
              >
                <div className="min-w-0 text-xs">
                  <span className="font-medium">{PAYMENT_METHOD_LABEL[option.paymentMethod]}</span>
                  {option.installments && option.installments > 1 && (
                    <span className="text-muted-foreground"> · {option.installments}x</span>
                  )}
                  {isChosen && (
                    <Badge variant="secondary" className="ml-1.5 gap-0.5 text-[10px]">
                      <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-3" />
                      Chosen
                    </Badge>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="font-amount text-xs tabular-nums">
                    {formatMoney(option.totalCostMinor, currencyCode)}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={isPending && busyId === option.id}
                      >
                        <HugeiconsIcon icon={MoreVerticalIcon} className="size-4" />
                        <span className="sr-only">Payment option actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!isChosen && (
                        <DropdownMenuItem onClick={() => choose(option)}>
                          <HugeiconsIcon icon={CheckmarkCircle02Icon} />
                          Set as chosen
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => setEditing(option)}>
                        <HugeiconsIcon icon={PencilEdit02Icon} />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => remove(option)}>
                        <HugeiconsIcon icon={Delete02Icon} />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <EditPaymentOptionDialog
          option={editing}
          currencyCode={currencyCode}
          cards={cards}
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
    </div>
  );
}
