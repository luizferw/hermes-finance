"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { todayIso } from "@kosh/domain";
import { createRecurring } from "@/modules/recurring/mutations";
import { createRecurringSchema } from "@/modules/recurring/validators";
import type { CategoryOption } from "@/components/transactions/category-picker";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const INTERVALS = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
] as const;

export function NewRecurringDialog({
  accounts,
  categories,
}: {
  accounts: Array<{ id: string; name: string }>;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createRecurringSchema),
    defaultValues: {
      name: "",
      type: "expense",
      accountId: accounts[0]?.id ?? "",
      transferAccountId: null,
      categoryId: null,
      amount: undefined as unknown as number,
      currencyCode: "INR",
      description: "",
      interval: "monthly",
      nextRunDate: todayIso(),
    },
  });
  const type = form.watch("type");
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createRecurring(values);
      toast.success(`${values.name} scheduled`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create recurring item");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={accounts.length === 0}>
          <HugeiconsIcon icon={PlusSignIcon} />
          New recurring
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New recurring transaction</DialogTitle>
          <DialogDescription>
            Kosh creates pending drafts on schedule so you can review them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <Tabs value={field.value} onValueChange={field.onChange}>
                  <TabsList className="w-full">
                    <TabsTrigger value="expense" className="flex-1">
                      Expense
                    </TabsTrigger>
                    <TabsTrigger value="income" className="flex-1">
                      Income
                    </TabsTrigger>
                    <TabsTrigger value="transfer" className="flex-1">
                      Transfer
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            />

            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="rec-name">Name</FieldLabel>
              <Input
                id="rec-name"
                placeholder="e.g. Salary, Netflix, SIP"
                {...form.register("name")}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="rec-description">Transaction description</FieldLabel>
              <Input
                id="rec-description"
                placeholder="Shown on generated drafts"
                {...form.register("description")}
              />
              {errors.description && (
                <FieldError>{errors.description.message}</FieldError>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="rec-amount">Amount</FieldLabel>
                <Input
                  id="rec-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("amount")}
                />
                {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.nextRunDate}>
                <FieldLabel htmlFor="rec-date">Next run</FieldLabel>
                <Input
                  id="rec-date"
                  type="date"
                  {...form.register("nextRunDate")}
                />
                {errors.nextRunDate && (
                  <FieldError>{errors.nextRunDate.message}</FieldError>
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <Field data-invalid={!!errors.accountId}>
                    <FieldLabel>{type === "transfer" ? "From" : "Account"}</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
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
                    {errors.accountId && (
                      <FieldError>{errors.accountId.message}</FieldError>
                    )}
                  </Field>
                )}
              />

              {type === "transfer" ? (
                <Controller
                  control={form.control}
                  name="transferAccountId"
                  render={({ field }) => (
                    <Field data-invalid={!!errors.transferAccountId}>
                      <FieldLabel>To</FieldLabel>
                      <Select
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Destination" />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {errors.transferAccountId && (
                        <FieldError>{errors.transferAccountId.message}</FieldError>
                      )}
                    </Field>
                  )}
                />
              ) : (
                <Controller
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <Field>
                      <FieldLabel>Category</FieldLabel>
                      <Select
                        value={field.value ?? "none"}
                        onValueChange={(value) =>
                          field.onChange(value === "none" ? null : value)
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Optional" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No category</SelectItem>
                          {categories.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                />
              )}
            </div>

            <Controller
              control={form.control}
              name="interval"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Repeats</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVALS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create recurring item
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
