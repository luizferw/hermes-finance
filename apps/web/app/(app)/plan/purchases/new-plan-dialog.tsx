"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createPurchasePlan } from "@/modules/finance/mutations";
import { createPurchasePlanSchema } from "@/modules/finance/validators";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/** An empty date or number input is "no value", not the epoch or zero. */
const emptyToNull = (value: unknown) => (value === "" ? null : value);

/**
 * A plan groups the things you are considering buying. It carries the currency
 * every item and payment option underneath it is priced in, so it is fixed here
 * and never asked again per item.
 */
export function NewPurchasePlanDialog({ defaultCurrency }: { defaultCurrency: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createPurchasePlanSchema),
    defaultValues: {
      name: "",
      description: "",
      targetDate: null,
      budget: null,
      currencyCode: defaultCurrency,
      status: "active" as const,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createPurchasePlan(values);
      toast.success(`${values.name} added`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the plan");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          New plan
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New purchase plan</DialogTitle>
          <DialogDescription>
            Group what you are considering buying, then compare how each way of
            paying would land on your cash.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="plan-name">Name</FieldLabel>
              <Input id="plan-name" placeholder="e.g. Home office" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field>
              <FieldLabel htmlFor="plan-description">Description</FieldLabel>
              <Textarea
                id="plan-description"
                rows={2}
                placeholder="Optional"
                {...form.register("description")}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.budget}>
                <FieldLabel htmlFor="plan-budget">Budget</FieldLabel>
                <Input
                  id="plan-budget"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="Optional"
                  {...form.register("budget", { setValueAs: emptyToNull })}
                />
                {errors.budget && <FieldError>{errors.budget.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.targetDate}>
                <FieldLabel htmlFor="plan-target-date">Target date</FieldLabel>
                <Input
                  id="plan-target-date"
                  type="date"
                  {...form.register("targetDate", { setValueAs: emptyToNull })}
                />
                {errors.targetDate && <FieldError>{errors.targetDate.message}</FieldError>}
              </Field>
            </div>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create plan
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
