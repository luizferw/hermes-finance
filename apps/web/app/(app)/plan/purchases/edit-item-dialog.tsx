"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { minorToMajor } from "@kosh/domain";
import { updatePurchaseItem } from "@/modules/finance/mutations";
import { updatePurchaseItemSchema } from "@/modules/finance/validators";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

/** An empty date input is "no date", not an unparseable one. */
const emptyToNull = (value: unknown) => (value === "" ? null : value);

export interface EditablePurchaseItem {
  id: string;
  name: string;
  estimatedPriceMinor: number;
  purchaseDate: string | null;
  accountId: string | null;
  installments: number;
}

/** Items carry no currency of their own — they are priced in the plan's. */
export function EditPurchaseItemDialog({
  item,
  currencyCode,
  accounts,
  open,
  onOpenChange,
}: {
  item: EditablePurchaseItem;
  currencyCode: string;
  accounts: Array<{ id: string; name: string; type: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(updatePurchaseItemSchema),
    defaultValues: {
      name: item.name,
      purchaseDate: item.purchaseDate,
      amount: minorToMajor(item.estimatedPriceMinor, currencyCode),
      accountId: item.accountId,
      installments: item.installments,
    },
  });
  const errors = form.formState.errors;
  const accountId = form.watch("accountId");
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const isCard = selectedAccount?.type === "credit_card";

  // Re-seed the form whenever a different item is opened for editing.
  React.useEffect(() => {
    if (open) {
      form.reset({
        name: item.name,
        purchaseDate: item.purchaseDate,
        amount: minorToMajor(item.estimatedPriceMinor, currencyCode),
        accountId: item.accountId,
        installments: item.installments,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updatePurchaseItem(item.id, values);
      toast.success(`${values.name ?? item.name} updated`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the item");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit item</DialogTitle>
          <DialogDescription>
            Prices are in {currencyCode}, the plan&apos;s currency.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-item-name">Name</FieldLabel>
              <Input id="edit-item-name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="edit-item-amount">Amount</FieldLabel>
                <Input
                  id="edit-item-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  {...form.register("amount")}
                />
                {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.purchaseDate}>
                <FieldLabel htmlFor="edit-item-purchase-date">Purchase date</FieldLabel>
                <Input
                  id="edit-item-purchase-date"
                  type="date"
                  {...form.register("purchaseDate", { setValueAs: emptyToNull })}
                />
                {errors.purchaseDate && <FieldError>{errors.purchaseDate.message}</FieldError>}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <Field data-invalid={!!errors.accountId}>
                    <FieldLabel>Account</FieldLabel>
                    <Select value={field.value ?? ""} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Pick an account" />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.accountId && <FieldError>{errors.accountId.message}</FieldError>}
                  </Field>
                )}
              />
              {isCard && (
                <Field data-invalid={!!errors.installments}>
                  <FieldLabel htmlFor="edit-item-installments">Instalments</FieldLabel>
                  <Input
                    id="edit-item-installments"
                    type="number"
                    step="1"
                    min="1"
                    inputMode="numeric"
                    {...form.register("installments")}
                  />
                  {errors.installments && <FieldError>{errors.installments.message}</FieldError>}
                </Field>
              )}
            </div>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Save changes
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
