"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { todayIso } from "@kosh/domain";
import { createAccount } from "@/modules/accounts/mutations";
import { createAccountSchema } from "@/modules/accounts/validators";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

const TYPE_OPTIONS = [
  {
    value: "asset",
    label: "Bank account",
    hint: "Savings or current account",
  },
  { value: "cash", label: "Cash", hint: "Physical wallet" },
  {
    value: "wallet",
    label: "Wallet",
    hint: "UPI / prepaid wallet — PhonePe, Paytm, GPay balance",
  },
  {
    value: "credit_card",
    label: "Credit card",
    hint: "Owe-this-cycle balance, with a limit",
  },
  {
    value: "liability",
    label: "Liability",
    hint: "Loan or debt — enter the outstanding amount as negative",
  },
  {
    value: "investment",
    label: "Investment",
    hint: "Stocks, mutual funds, FD/RD, gold, PPF/EPF/NPS",
  },
] as const;

export function NewAccountDialog({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const form = useForm({
    resolver: zodResolver(createAccountSchema),
    defaultValues: {
      name: "",
      type: "asset",
      currencyCode: "INR",
      openingBalance: 0,
      openingBalanceDate: todayIso(),
      includeInNetWorth: true,
    },
  });
  const type = form.watch("type");
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createAccount(values);
      toast.success(`${values.name} added`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create account");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8">
          <HugeiconsIcon icon={PlusSignIcon} />
          <span className="hidden sm:inline">New account</span>
          <span className="sm:hidden">New</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
          <DialogDescription>
            A money container — bank account, card, wallet, or loan.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="acc-name">Name</FieldLabel>
              <Input
                id="acc-name"
                placeholder="e.g. HDFC Salary Account"
                {...form.register("name")}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Type</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {TYPE_OPTIONS.find((o) => o.value === field.value)?.hint}
                  </FieldDescription>
                </Field>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!errors.openingBalance}>
                <FieldLabel htmlFor="acc-opening">Opening balance</FieldLabel>
                <Input
                  id="acc-opening"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  {...form.register("openingBalance")}
                />
                {errors.openingBalance && (
                  <FieldError>{errors.openingBalance.message}</FieldError>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="acc-date">As of</FieldLabel>
                <Input
                  id="acc-date"
                  type="date"
                  {...form.register("openingBalanceDate")}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="acc-institution">Institution</FieldLabel>
                <Input
                  id="acc-institution"
                  placeholder="e.g. HDFC Bank"
                  {...form.register("institution")}
                />
              </Field>
              {type === "credit_card" || type === "liability" ? (
                <Field>
                  <FieldLabel htmlFor="acc-limit">
                    {type === "credit_card" ? "Credit limit" : "Original principal"}
                  </FieldLabel>
                  <Input
                    id="acc-limit"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    {...form.register("limit")}
                  />
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="acc-upi">UPI ID</FieldLabel>
                  <Input
                    id="acc-upi"
                    placeholder="you@okhdfcbank (optional)"
                    {...form.register("upiId")}
                  />
                </Field>
              )}
            </div>

            <Controller
              control={form.control}
              name="includeInNetWorth"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <span>
                    <FieldLabel htmlFor="acc-networth">Count in net worth</FieldLabel>
                    <FieldDescription>
                      Turn off for accounts you track but don’t own.
                    </FieldDescription>
                  </span>
                  <Switch
                    id="acc-networth"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </Field>
              )}
            />

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create account
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
