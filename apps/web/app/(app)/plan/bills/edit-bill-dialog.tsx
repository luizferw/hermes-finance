"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { minorToMajor } from "@kosh/domain";
import { updateBill } from "@/modules/bills/mutations";
import { updateBillSchema } from "@/modules/bills/validators";
import type { CategoryOption } from "@/components/transactions/category-picker";
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
import { Textarea } from "@/components/ui/textarea";

const RECURRENCES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
] as const;

const AMOUNT_STRATEGIES = [
  { value: "fixed", label: "Fixed", hint: "Always the same amount" },
  { value: "variable", label: "Variable", hint: "Changes each time — e.g. electricity" },
] as const;

export interface EditableBill {
  id: string;
  name: string;
  expectedAmountMinor: number;
  currencyCode: string;
  recurrence: "weekly" | "monthly" | "quarterly" | "yearly";
  amountStrategy: "fixed" | "variable";
  nextDueDate: string;
  accountId: string | null;
  categoryId: string | null;
  notes: string | null;
}

export function EditBillDialog({
  bill,
  open,
  onOpenChange,
  accounts,
  categories,
}: {
  bill: EditableBill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Array<{ id: string; name: string }>;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(updateBillSchema),
    defaultValues: {
      name: bill.name,
      expectedAmount: minorToMajor(bill.expectedAmountMinor, bill.currencyCode),
      recurrence: bill.recurrence,
      amountStrategy: bill.amountStrategy,
      nextDueDate: bill.nextDueDate,
      accountId: bill.accountId,
      categoryId: bill.categoryId,
      notes: bill.notes ?? "",
    },
  });
  const errors = form.formState.errors;

  // Re-seed the form whenever a different bill is opened for editing.
  React.useEffect(() => {
    if (open) {
      form.reset({
        name: bill.name,
        expectedAmount: minorToMajor(bill.expectedAmountMinor, bill.currencyCode),
        recurrence: bill.recurrence,
        amountStrategy: bill.amountStrategy,
        nextDueDate: bill.nextDueDate,
        accountId: bill.accountId,
        categoryId: bill.categoryId,
        notes: bill.notes ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updateBill(bill.id, values);
      toast.success(`${values.name ?? bill.name} updated`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the bill");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit bill</DialogTitle>
          <DialogDescription>
            Update the due date, amount, or where this bill is tracked.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-bill-name">Name</FieldLabel>
              <Input
                id="edit-bill-name"
                placeholder="e.g. Electricity"
                {...form.register("name")}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.expectedAmount}>
                <FieldLabel htmlFor="edit-bill-amount">Expected amount</FieldLabel>
                <Input
                  id="edit-bill-amount"
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
                <FieldLabel htmlFor="edit-bill-date">Next due date</FieldLabel>
                <Input
                  id="edit-bill-date"
                  type="date"
                  {...form.register("nextDueDate", {
                    // An empty date input submits "", which fails the yyyy-MM-dd
                    // regex; map it to undefined so the (optional) field is
                    // simply left unchanged rather than rejected.
                    setValueAs: (v) => (v === "" ? undefined : v),
                  })}
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
                name="amountStrategy"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Amount</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AMOUNT_STRATEGIES.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label} — {option.hint}
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
              <FieldLabel htmlFor="edit-bill-notes">Notes</FieldLabel>
              <Textarea
                id="edit-bill-notes"
                rows={2}
                placeholder="Optional"
                {...form.register("notes")}
              />
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
