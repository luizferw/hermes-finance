"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createCreditCard } from "@/modules/finance/mutations";
import { createCreditCardSchema } from "@/modules/finance/validators";
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
import { minorToMajor } from "@kosh/domain";

export interface CardAccountOption {
  id: string;
  name: string;
  currencyCode: string;
  institution?: string | null;
  /** Credit limit already recorded on the ledger account, in minor units. */
  limitMinor?: number | null;
}

/**
 * Turns an imported `credit_card` account into a Hermes credit card.
 *
 * The ledger account carries balance and history; the card record carries the
 * Brazilian domain — limit, closing day, due day, and which account settles the
 * bill. None of that can be derived from a statement import, so it is asked for
 * once here rather than guessed.
 */
export function NewCardDialog({
  cardAccounts,
  paymentAccounts,
  defaultCurrency,
}: {
  cardAccounts: CardAccountOption[];
  paymentAccounts: CardAccountOption[];
  defaultCurrency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createCreditCardSchema),
    defaultValues: {
      accountId: "",
      name: "",
      issuer: "",
      currencyCode: defaultCurrency,
      creditLimit: undefined as unknown as number,
      defaultClosingDay: undefined as unknown as number,
      defaultDueDay: undefined as unknown as number,
      paymentAccountId: null,
      active: true,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createCreditCard(values);
      toast.success(`${values.name} added`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the card");
    }
  });

  // Every card needs a ledger account behind it. Rather than hiding the button
  // and leaving a dead end, say what is missing and where to fix it.
  if (cardAccounts.length === 0) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            <HugeiconsIcon icon={PlusSignIcon} />
            Add card
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>No account to link</DialogTitle>
            <DialogDescription>
              A card is tracked on top of a ledger account, which holds its
              balance and history. Every credit-card account you have is already
              linked to a card. Create one under Accounts with the type
              &ldquo;credit card&rdquo;, then come back here.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          Add card
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a credit card</DialogTitle>
          <DialogDescription>
            Pick the account the card already uses — name, issuer and limit are
            carried over from it. Only the cycle rules are new.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.accountId}>
              <FieldLabel htmlFor="card-account">Card account</FieldLabel>
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <Select
                    value={field.value || undefined}
                    onValueChange={(value) => {
                      field.onChange(value);
                      const picked = cardAccounts.find((a) => a.id === value);
                      if (!picked) return;
                      // Inherit whatever the account already knows; only the
                      // cycle rules are genuinely new information.
                      form.setValue("currencyCode", picked.currencyCode);
                      form.setValue("name", picked.name);
                      form.setValue("issuer", picked.institution ?? "");
                      if (picked.limitMinor != null) {
                        form.setValue(
                          "creditLimit",
                          Math.abs(minorToMajor(picked.limitMinor, picked.currencyCode)),
                        );
                      }
                    }}
                  >
                    <SelectTrigger id="card-account">
                      <SelectValue placeholder="Select the account" />
                    </SelectTrigger>
                    <SelectContent>
                      {cardAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.accountId && <FieldError>{errors.accountId.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="card-name">
                Name <span className="font-normal text-muted-foreground">· from the account</span>
              </FieldLabel>
              <Input id="card-name" placeholder="e.g. Inter Gold" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.creditLimit}>
              <FieldLabel htmlFor="card-limit">
                Credit limit{" "}
                <span className="font-normal text-muted-foreground">· from the account</span>
              </FieldLabel>
              <Input
                id="card-limit"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                placeholder="0.00"
                {...form.register("creditLimit")}
              />
              {errors.creditLimit && <FieldError>{errors.creditLimit.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.defaultClosingDay}>
                <FieldLabel htmlFor="card-closing">Closing day</FieldLabel>
                <Input
                  id="card-closing"
                  type="number"
                  min="1"
                  max="31"
                  inputMode="numeric"
                  placeholder="25"
                  {...form.register("defaultClosingDay")}
                />
                {errors.defaultClosingDay && (
                  <FieldError>{errors.defaultClosingDay.message}</FieldError>
                )}
              </Field>
              <Field data-invalid={!!errors.defaultDueDay}>
                <FieldLabel htmlFor="card-due">Due day</FieldLabel>
                <Input
                  id="card-due"
                  type="number"
                  min="1"
                  max="31"
                  inputMode="numeric"
                  placeholder="2"
                  {...form.register("defaultDueDay")}
                />
                {errors.defaultDueDay && (
                  <FieldError>{errors.defaultDueDay.message}</FieldError>
                )}
              </Field>
            </div>

            <Field data-invalid={!!errors.paymentAccountId}>
              <FieldLabel htmlFor="card-payment">Paid from</FieldLabel>
              <Controller
                control={form.control}
                name="paymentAccountId"
                render={({ field }) => (
                  <Select
                    value={field.value ?? undefined}
                    onValueChange={(value) => field.onChange(value)}
                  >
                    <SelectTrigger id="card-payment">
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
              {errors.paymentAccountId && (
                <FieldError>{errors.paymentAccountId.message}</FieldError>
              )}
            </Field>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Add card
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
