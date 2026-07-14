"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createBudget } from "@/modules/budgets/mutations";
import { createBudgetSchema } from "@/modules/budgets/validators";
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

export function NewBudgetDialog({
  categories,
  defaultOpen = false,
}: {
  categories: CategoryOption[];
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const form = useForm({
    resolver: zodResolver(createBudgetSchema),
    defaultValues: {
      name: "",
      categoryIds: [] as string[],
      plannedAmount: undefined as unknown as number,
      currencyCode: "INR",
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createBudget(values);
      toast.success(`Budget “${values.name}” created`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create budget");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} /> New budget
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New budget</DialogTitle>
          <DialogDescription>
            A monthly envelope for one or more categories.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="budget-name">Name</FieldLabel>
              <Input
                id="budget-name"
                placeholder="e.g. Groceries"
                {...form.register("name")}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.plannedAmount}>
              <FieldLabel htmlFor="budget-amount">Monthly amount</FieldLabel>
              <Input
                id="budget-amount"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                placeholder="e.g. 12000"
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
                      const selected = field.value.includes(category.id);
                      return (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() =>
                            field.onChange(
                              selected
                                ? field.value.filter((id: string) => id !== category.id)
                                : [...field.value, category.id],
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
              Create budget
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
