"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createPurchaseItem } from "@/modules/finance/mutations";
import { createPurchaseItemSchema } from "@/modules/finance/validators";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

/**
 * Adds one thing to a plan: what it is, when it will be bought, what it
 * costs, and which account pays for it. Nothing else — this is a wish, not a
 * fact, and the horizon impact is computed from exactly these fields.
 *
 * Instalments only apply to a credit-card account, so the field only appears
 * once one is picked.
 */
export function NewPurchaseItemDialog({
  purchasePlanId,
  currencyCode,
  accounts,
}: {
  purchasePlanId: string;
  currencyCode: string;
  accounts: Array<{ id: string; name: string; type: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createPurchaseItemSchema),
    defaultValues: {
      purchasePlanId,
      name: "",
      purchaseDate: null,
      amount: undefined as unknown as number,
      accountId: accounts[0]?.id ?? null,
      installments: 1,
    },
  });
  const errors = form.formState.errors;
  const accountId = form.watch("accountId");
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const isCard = selectedAccount?.type === "credit_card";

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createPurchaseItem(values);
      toast.success(`${values.name} added`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the item");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          Add item
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an item</DialogTitle>
          <DialogDescription>
            What it is, when it will be bought, what it costs, and which account pays for it.
            Prices are in {currencyCode}, the plan&apos;s currency.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="item-name">Name</FieldLabel>
              <Input id="item-name" placeholder="e.g. Standing desk" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="item-amount">Amount</FieldLabel>
                <Input
                  id="item-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("amount")}
                />
                {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.purchaseDate}>
                <FieldLabel htmlFor="item-purchase-date">Purchase date</FieldLabel>
                <Input
                  id="item-purchase-date"
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
                  <FieldLabel htmlFor="item-installments">Instalments</FieldLabel>
                  <Input
                    id="item-installments"
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
              Add item
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
