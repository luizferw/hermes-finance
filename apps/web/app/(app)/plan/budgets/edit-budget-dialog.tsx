"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { updateBudget } from "@/modules/budgets/mutations";
import { updateBudgetSchema } from "@/modules/budgets/validators";
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface EditableBudget {
  id: string;
  name: string;
  plannedAmount: number;
  categoryIds: string[];
}

/**
 * Fixes a budget's name, monthly amount or category set. `updateBudget`
 * upserts the current month's period, so a changed amount takes effect for
 * the month in progress rather than only from the next one.
 */
export function EditBudgetDialog({
  budget,
  categories,
}: {
  budget: EditableBudget;
  categories: CategoryOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(updateBudgetSchema),
    defaultValues: {
      name: budget.name,
      categoryIds: budget.categoryIds,
      plannedAmount: budget.plannedAmount,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updateBudget(budget.id, values);
      toast.success(`${values.name ?? budget.name} updated`);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the budget");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm">
          <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
          <span className="sr-only">Edit budget</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit budget</DialogTitle>
          <DialogDescription>
            Changes apply to the current month&apos;s plan.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-budget-name">Name</FieldLabel>
              <Input id="edit-budget-name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.plannedAmount}>
              <FieldLabel htmlFor="edit-budget-amount">Monthly amount</FieldLabel>
              <Input
                id="edit-budget-amount"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                {...form.register("plannedAmount")}
              />
              {errors.plannedAmount && (
                <FieldError>{errors.plannedAmount.message}</FieldError>
              )}
            </Field>

            <Controller
              control={form.control}
              name="categoryIds"
              render={({ field }) => (
                <Field data-invalid={!!errors.categoryIds}>
                  <FieldLabel>Categories</FieldLabel>
                  <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                    {categories.map((category) => {
                      const selected = (field.value ?? []).includes(category.id);
                      return (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() =>
                            field.onChange(
                              selected
                                ? (field.value ?? []).filter((id: string) => id !== category.id)
                                : [...(field.value ?? []), category.id],
                            )
                          }
                          className={cn(
                            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                            selected
                              ? "border-primary bg-primary/10 text-primary"
                              : "text-muted-foreground hover:bg-accent",
                          )}
                        >
                          <span
                            aria-hidden
                            className="size-1.5 rounded-full"
                            style={{
                              background: category.color ?? "var(--muted-foreground)",
                            }}
                          />
                          {category.name}
                        </button>
                      );
                    })}
                  </div>
                  <FieldDescription>
                    Spending in these categories counts against this budget.
                  </FieldDescription>
                  {errors.categoryIds && (
                    <FieldError>{errors.categoryIds.message as string}</FieldError>
                  )}
                </Field>
              )}
            />

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
