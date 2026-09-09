"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createPaymentOption } from "@/modules/finance/mutations";
import { createPaymentOptionSchema } from "@/modules/finance/validators";
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

/** An empty date/number input is "no value", not zero or an unparseable string. */
const emptyToNull = (value: unknown) => (value === "" ? null : value);

export const PAYMENT_METHODS = [
  { value: "pix", label: "Pix" },
  { value: "boleto", label: "Boleto" },
  { value: "cash", label: "Cash" },
  { value: "credit_card", label: "Credit card" },
  { value: "debit_card", label: "Debit card" },
] as const;

/**
 * Records one way this item could be paid for. The comparison on the detail
 * page only has something to render once at least one of these exists —
 * nothing here computes the comparison itself.
 */
export function NewPaymentOptionDialog({
  purchaseItemId,
  currencyCode,
  cards,
}: {
  purchaseItemId: string;
  currencyCode: string;
  cards: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createPaymentOptionSchema),
    defaultValues: {
      purchaseItemId,
      paymentMethod: "pix" as const,
      cardId: null,
      cashPrice: null,
      installments: null,
      installmentAmount: null,
      totalCost: undefined as unknown as number,
      firstPaymentDate: null,
    },
  });
  const errors = form.formState.errors;
  const paymentMethod = form.watch("paymentMethod");

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createPaymentOption(values);
      toast.success("Payment option added");
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the payment option");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <HugeiconsIcon icon={PlusSignIcon} />
          Add option
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a payment option</DialogTitle>
          <DialogDescription>
            One way this item could be paid for. Amounts are in {currencyCode}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="paymentMethod"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Method</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_METHODS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              {paymentMethod === "credit_card" && (
                <Field data-invalid={!!errors.cardId}>
                  <FieldLabel>Card</FieldLabel>
                  <Controller
                    control={form.control}
                    name="cardId"
                    render={({ field }) => (
                      <Select value={field.value ?? undefined} onValueChange={field.onChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select the card" />
                        </SelectTrigger>
                        <SelectContent>
                          {cards.map((card) => (
                            <SelectItem key={card.id} value={card.id}>
                              {card.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {errors.cardId && <FieldError>{errors.cardId.message}</FieldError>}
                </Field>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.cashPrice}>
                <FieldLabel htmlFor="option-cash-price">Cash price</FieldLabel>
                <Input
                  id="option-cash-price"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="Optional"
                  {...form.register("cashPrice", { setValueAs: emptyToNull })}
                />
                {errors.cashPrice && <FieldError>{errors.cashPrice.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.totalCost}>
                <FieldLabel htmlFor="option-total-cost">Total cost</FieldLabel>
                <Input
                  id="option-total-cost"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("totalCost")}
                />
                {errors.totalCost && <FieldError>{errors.totalCost.message}</FieldError>}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.installments}>
                <FieldLabel htmlFor="option-installments">Installments</FieldLabel>
                <Input
                  id="option-installments"
                  type="number"
                  step="1"
                  min="1"
                  inputMode="numeric"
                  placeholder="Optional"
                  {...form.register("installments", { setValueAs: emptyToNull })}
                />
                {errors.installments && <FieldError>{errors.installments.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.installmentAmount}>
                <FieldLabel htmlFor="option-installment-amount">Installment amount</FieldLabel>
                <Input
                  id="option-installment-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="Optional"
                  {...form.register("installmentAmount", { setValueAs: emptyToNull })}
                />
                {errors.installmentAmount && (
                  <FieldError>{errors.installmentAmount.message}</FieldError>
                )}
              </Field>
            </div>

            <Field data-invalid={!!errors.firstPaymentDate}>
              <FieldLabel htmlFor="option-first-payment">First payment date</FieldLabel>
              <Input
                id="option-first-payment"
                type="date"
                placeholder="Optional"
                {...form.register("firstPaymentDate", { setValueAs: emptyToNull })}
              />
              {errors.firstPaymentDate && (
                <FieldError>{errors.firstPaymentDate.message}</FieldError>
              )}
            </Field>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Add option
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
