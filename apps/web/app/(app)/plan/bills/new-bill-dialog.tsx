"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { todayIso } from "@kosh/domain";
import { createBill } from "@/modules/bills/mutations";
import { createBillSchema } from "@/modules/bills/validators";
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
import { Textarea } from "@/components/ui/textarea";

const RECURRENCES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
] as const;

export function NewBillDialog({
  accounts,
  categories,
}: {
  accounts: Array<{ id: string; name: string }>;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createBillSchema),
    defaultValues: {
      name: "",
      expectedAmount: undefined as unknown as number,
      currencyCode: "INR",
      recurrence: "monthly",
      nextDueDate: todayIso(),
      accountId: null,
      categoryId: null,
      notes: "",
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createBill(values);
      toast.success(`${values.name} added`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create bill");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          New bill
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New bill</DialogTitle>
          <DialogDescription>
            Add a due date and expected amount for a repeating payment.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="bill-name">Name</FieldLabel>
              <Input
                id="bill-name"
                placeholder="e.g. Electricity"
                {...form.register("name")}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.expectedAmount}>
                <FieldLabel htmlFor="bill-amount">Expected amount</FieldLabel>
                <Input
                  id="bill-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("expectedAmount")}
                />
                {errors.expectedAmount && (
                  <FieldError>{errors.expectedAmount.message}</FieldError>
                )}
              </Field>
              <Field data-invalid={!!errors.nextDueDate}>
                <FieldLabel htmlFor="bill-date">Next due date</FieldLabel>
                <Input
                  id="bill-date"
                  type="date"
                  {...form.register("nextDueDate")}
                />
                {errors.nextDueDate && (
                  <FieldError>{errors.nextDueDate.message}</FieldError>
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="recurrence"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Repeats</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RECURRENCES.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Account</FieldLabel>
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
                        <SelectItem value="none">No account</SelectItem>
                        {accounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
            </div>

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

            <Field>
              <FieldLabel htmlFor="bill-notes">Notes</FieldLabel>
              <Textarea
                id="bill-notes"
                rows={2}
                placeholder="Optional"
                {...form.register("notes")}
              />
            </Field>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create bill
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
