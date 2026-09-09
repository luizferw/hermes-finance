"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { updateCreditCard } from "@/modules/finance/mutations";
import { updateCreditCardSchema } from "@/modules/finance/validators";
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

export interface EditableCard {
  id: string;
  name: string;
  issuer: string | null;
  currencyCode: string;
  creditLimitMinor: number;
  defaultClosingDay: number;
  defaultDueDay: number;
  paymentAccountId: string | null;
}

/**
 * Fixes a wrong limit, closing day, due day or paying account after the
 * fact. Every derived number on this card — available limit, which
 * statement a purchase lands in — comes from these fields, so getting one
 * wrong at creation used to mean living with it.
 */
export function EditCardDialog({
  card,
  paymentAccounts,
}: {
  card: EditableCard;
  paymentAccounts: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(updateCreditCardSchema),
    defaultValues: {
      name: card.name,
      issuer: card.issuer ?? "",
      currencyCode: card.currencyCode,
      creditLimit: card.creditLimitMinor / 100,
      defaultClosingDay: card.defaultClosingDay,
      defaultDueDay: card.defaultDueDay,
      paymentAccountId: card.paymentAccountId,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updateCreditCard(card.id, values);
      toast.success(`${values.name ?? card.name} updated`);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the card");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <HugeiconsIcon icon={PencilEdit02Icon} />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit card</DialogTitle>
          <DialogDescription>
            Every derived number here — available limit, which statement a
            purchase lands in — comes from these fields.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-card-name">Name</FieldLabel>
              <Input id="edit-card-name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.issuer}>
              <FieldLabel htmlFor="edit-card-issuer">Issuer</FieldLabel>
              <Input id="edit-card-issuer" {...form.register("issuer")} />
              {errors.issuer && <FieldError>{errors.issuer.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.creditLimit}>
              <FieldLabel htmlFor="edit-card-limit">Credit limit</FieldLabel>
              <Input
                id="edit-card-limit"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                {...form.register("creditLimit")}
              />
              {errors.creditLimit && <FieldError>{errors.creditLimit.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.defaultClosingDay}>
                <FieldLabel htmlFor="edit-card-closing">Closing day</FieldLabel>
                <Input
                  id="edit-card-closing"
                  type="number"
                  min="1"
                  max="31"
                  inputMode="numeric"
                  {...form.register("defaultClosingDay")}
                />
                {errors.defaultClosingDay && <FieldError>{errors.defaultClosingDay.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.defaultDueDay}>
                <FieldLabel htmlFor="edit-card-due">Due day</FieldLabel>
                <Input
                  id="edit-card-due"
                  type="number"
                  min="1"
                  max="31"
                  inputMode="numeric"
                  {...form.register("defaultDueDay")}
                />
                {errors.defaultDueDay && <FieldError>{errors.defaultDueDay.message}</FieldError>}
              </Field>
            </div>

            <Field data-invalid={!!errors.paymentAccountId}>
              <FieldLabel htmlFor="edit-card-payment">Paid from</FieldLabel>
              <Controller
                control={form.control}
                name="paymentAccountId"
                render={({ field }) => (
                  <Select value={field.value ?? undefined} onValueChange={field.onChange}>
                    <SelectTrigger id="edit-card-payment">
                      <SelectValue placeholder="Select the settling account" />
                    </SelectTrigger>
                    <SelectContent>
                      {paymentAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.paymentAccountId && <FieldError>{errors.paymentAccountId.message}</FieldError>}
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
