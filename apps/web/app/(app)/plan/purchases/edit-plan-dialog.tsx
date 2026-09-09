"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { minorToMajor } from "@kosh/domain";
import { updatePurchasePlan } from "@/modules/finance/mutations";
import { updatePurchasePlanSchema } from "@/modules/finance/validators";
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

/** An empty date input is "no date", not an unparseable one. */
const emptyToNull = (value: unknown) => (value === "" ? null : value);

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
] as const;

export interface EditablePurchasePlan {
  id: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  budgetMinor: number | null;
  currencyCode: string;
  status: "active" | "completed" | "archived";
}

export function EditPurchasePlanDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: EditablePurchasePlan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(updatePurchasePlanSchema),
    defaultValues: {
      name: plan.name,
      description: plan.description ?? "",
      targetDate: plan.targetDate,
      budget: plan.budgetMinor != null ? minorToMajor(plan.budgetMinor, plan.currencyCode) : null,
      currencyCode: plan.currencyCode,
      status: plan.status,
    },
  });
  const errors = form.formState.errors;

  // Re-seed the form whenever a different plan is opened for editing.
  React.useEffect(() => {
    if (open) {
      form.reset({
        name: plan.name,
        description: plan.description ?? "",
        targetDate: plan.targetDate,
        budget: plan.budgetMinor != null ? minorToMajor(plan.budgetMinor, plan.currencyCode) : null,
        currencyCode: plan.currencyCode,
        status: plan.status,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updatePurchasePlan(plan.id, values);
      toast.success(`${values.name ?? plan.name} updated`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the plan");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit plan</DialogTitle>
          <DialogDescription>
            Update the plan&apos;s name, target date, budget, or status.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-plan-name">Name</FieldLabel>
              <Input id="edit-plan-name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.targetDate}>
                <FieldLabel htmlFor="edit-plan-target">Target date</FieldLabel>
                <Input
                  id="edit-plan-target"
                  type="date"
                  {...form.register("targetDate", { setValueAs: emptyToNull })}
                />
                {errors.targetDate && <FieldError>{errors.targetDate.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.budget}>
                <FieldLabel htmlFor="edit-plan-budget">Budget</FieldLabel>
                <Input
                  id="edit-plan-budget"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="Optional"
                  {...form.register("budget", { setValueAs: emptyToNull })}
                />
                {errors.budget && <FieldError>{errors.budget.message}</FieldError>}
              </Field>
            </div>

            <Controller
              control={form.control}
              name="status"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Status</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />

            <Field>
              <FieldLabel htmlFor="edit-plan-description">Description</FieldLabel>
              <Textarea
                id="edit-plan-description"
                rows={2}
                placeholder="Optional"
                {...form.register("description")}
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
