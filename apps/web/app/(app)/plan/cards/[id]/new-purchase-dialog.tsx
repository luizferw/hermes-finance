"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { registerCardPurchase } from "@/modules/finance/mutations";
import { registerCardPurchaseSchema } from "@/modules/finance/validators";
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

export interface CategoryOption {
  id: string;
  name: string;
}

/**
 * Registers a new purchase on this card, splitting it into installments when
 * asked. This is for a purchase happening now, not for backfilling history —
 * an imported card's past purchases already live in the ledger, and running
 * this against one would double it.
 */
export function NewPurchaseDialog({
  creditCardId,
  categories,
  todayIso,
}: {
  creditCardId: string;
  categories: CategoryOption[];
  todayIso: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(registerCardPurchaseSchema),
    defaultValues: {
      creditCardId,
      purchaseDate: todayIso,
      totalAmount: undefined as unknown as number,
      totalInstallments: 1,
      description: "",
      merchant: "",
      categoryId: null,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await registerCardPurchase(values);
      toast.success(`${values.description} registered`);
      form.reset({
        creditCardId,
        purchaseDate: todayIso,
        totalAmount: undefined as unknown as number,
        totalInstallments: 1,
        description: "",
        merchant: "",
        categoryId: null,
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not register the purchase");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          New purchase
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register a card purchase</DialogTitle>
          <DialogDescription>
            Splits the total into installments and lands each one in the
            statement it will actually be billed in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="purchase-description">Description</FieldLabel>
              <Input id="purchase-description" placeholder="e.g. Notebook" {...form.register("description")} />
              {errors.description && <FieldError>{errors.description.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.totalAmount}>
                <FieldLabel htmlFor="purchase-amount">Total amount</FieldLabel>
                <Input
                  id="purchase-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("totalAmount")}
                />
                {errors.totalAmount && <FieldError>{errors.totalAmount.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.totalInstallments}>
                <FieldLabel htmlFor="purchase-installments">Installments</FieldLabel>
                <Input
                  id="purchase-installments"
                  type="number"
                  min="1"
                  inputMode="numeric"
                  {...form.register("totalInstallments")}
                />
                {errors.totalInstallments && <FieldError>{errors.totalInstallments.message}</FieldError>}
              </Field>
            </div>

            <Field data-invalid={!!errors.purchaseDate}>
              <FieldLabel htmlFor="purchase-date">Purchase date</FieldLabel>
              <Input id="purchase-date" type="date" {...form.register("purchaseDate")} />
              {errors.purchaseDate && <FieldError>{errors.purchaseDate.message}</FieldError>}
            </Field>

            {categories.length > 0 && (
              <Field data-invalid={!!errors.categoryId}>
                <FieldLabel htmlFor="purchase-category">Category</FieldLabel>
                <Controller
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <Select value={field.value ?? undefined} onValueChange={field.onChange}>
                      <SelectTrigger id="purchase-category">
                        <SelectValue placeholder="Optional" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((category) => (
                          <SelectItem key={category.id} value={category.id}>
                            {category.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.categoryId && <FieldError>{errors.categoryId.message}</FieldError>}
              </Field>
            )}

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Register purchase
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
