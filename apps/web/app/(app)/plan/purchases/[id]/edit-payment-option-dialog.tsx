"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { minorToMajor } from "@kosh/domain";
import { updatePaymentOption } from "@/modules/finance/mutations";
import { updatePaymentOptionSchema } from "@/modules/finance/validators";
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
import { PAYMENT_METHODS } from "./new-payment-option-dialog";

/** An empty date/number input is "no value", not zero or an unparseable string. */
const emptyToNull = (value: unknown) => (value === "" ? null : value);

export interface EditablePaymentOption {
  id: string;
  paymentMethod: "pix" | "boleto" | "cash" | "credit_card" | "debit_card";
  cardId: string | null;
  cashPriceMinor: number | null;
  installments: number | null;
  installmentAmountMinor: number | null;
  totalCostMinor: number;
  firstPaymentDate: string | null;
}

export function EditPaymentOptionDialog({
  option,
  currencyCode,
  cards,
  open,
  onOpenChange,
}: {
  option: EditablePaymentOption;
  currencyCode: string;
  cards: Array<{ id: string; name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const buildDefaults = React.useCallback(
    () => ({
      paymentMethod: option.paymentMethod,
      cardId: option.cardId,
      cashPrice: option.cashPriceMinor != null ? minorToMajor(option.cashPriceMinor, currencyCode) : null,
      installments: option.installments,
      installmentAmount:
        option.installmentAmountMinor != null
          ? minorToMajor(option.installmentAmountMinor, currencyCode)
          : null,
      totalCost: minorToMajor(option.totalCostMinor, currencyCode),
      firstPaymentDate: option.firstPaymentDate,
    }),
    [option, currencyCode],
  );
  const form = useForm({
    resolver: zodResolver(updatePaymentOptionSchema),
    defaultValues: buildDefaults(),
  });
  const errors = form.formState.errors;
  const paymentMethod = form.watch("paymentMethod");

  // Re-seed the form whenever a different option is opened for editing.
  React.useEffect(() => {
    if (open) form.reset(buildDefaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, option.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updatePaymentOption(option.id, values);
      toast.success("Payment option updated");
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the payment option");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit payment option</DialogTitle>
          <DialogDescription>Amounts are in {currencyCode}.</DialogDescription>
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
                <FieldLabel htmlFor="edit-option-cash-price">Cash price</FieldLabel>
                <Input
                  id="edit-option-cash-price"
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
                <FieldLabel htmlFor="edit-option-total-cost">Total cost</FieldLabel>
                <Input
                  id="edit-option-total-cost"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  {...form.register("totalCost")}
                />
                {errors.totalCost && <FieldError>{errors.totalCost.message}</FieldError>}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.installments}>
                <FieldLabel htmlFor="edit-option-installments">Installments</FieldLabel>
                <Input
                  id="edit-option-installments"
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
                <FieldLabel htmlFor="edit-option-installment-amount">Installment amount</FieldLabel>
                <Input
                  id="edit-option-installment-amount"
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
              <FieldLabel htmlFor="edit-option-first-payment">First payment date</FieldLabel>
              <Input
                id="edit-option-first-payment"
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
              Save changes
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
