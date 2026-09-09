"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createPurchaseItem } from "@/modules/finance/mutations";
import { createPurchaseItemSchema } from "@/modules/finance/validators";
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

/** An empty date or number input is "no value", not an unparseable one. */
const emptyToNull = (value: unknown) => (value === "" ? null : value);

const PRIORITIES = [
  { value: "must_have", label: "Must have" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "optional", label: "Optional" },
] as const;

const STATUSES = [
  { value: "idea", label: "Idea" },
  { value: "planned", label: "Planned" },
  { value: "ready", label: "Ready" },
] as const;

/**
 * Adds one thing to a plan. The estimated price is in the plan's currency —
 * items never carry their own, which is what lets the recommendation compare
 * them.
 *
 * This is a wish, not a fact: nothing here touches the ledger. The purchase
 * becomes a transaction only when it actually happens.
 *
 * Name, price, deadline and an optional installment cap are the whole primary
 * form — the recommendation engine only needs those to propose how to pay for
 * it. Priority, status, an earliest-purchase date and notes are all real
 * fields, but nobody typing a list of nine things should have to fill in five
 * fields per item just to get them recorded; they stay editable afterwards.
 */
export function NewPurchaseItemDialog({
  purchasePlanId,
  currencyCode,
}: {
  purchasePlanId: string;
  currencyCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [moreOptionsOpen, setMoreOptionsOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createPurchaseItemSchema),
    defaultValues: {
      purchasePlanId,
      name: "",
      priority: "medium" as const,
      estimatedPrice: undefined as unknown as number,
      actualPrice: null,
      earliestPurchaseDate: null,
      deadline: null,
      status: "idea" as const,
      notes: "",
      maxInstallments: null,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createPurchaseItem(values);
      toast.success(`${values.name} added`);
      form.reset();
      setMoreOptionsOpen(false);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the item");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          Add item
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an item</DialogTitle>
          <DialogDescription>
            Name, price and when you need it — that&apos;s enough to get a recommendation.
            Prices are in {currencyCode}, the plan&apos;s currency.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="item-name">Name</FieldLabel>
              <Input id="item-name" placeholder="e.g. Standing desk" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.estimatedPrice}>
                <FieldLabel htmlFor="item-price">Price</FieldLabel>
                <Input
                  id="item-price"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("estimatedPrice")}
                />
                {errors.estimatedPrice && (
                  <FieldError>{errors.estimatedPrice.message}</FieldError>
                )}
              </Field>
              <Field data-invalid={!!errors.deadline}>
                <FieldLabel htmlFor="item-deadline">Needed by</FieldLabel>
                <Input
                  id="item-deadline"
                  type="date"
                  {...form.register("deadline", { setValueAs: emptyToNull })}
                />
                {errors.deadline && <FieldError>{errors.deadline.message}</FieldError>}
              </Field>
            </div>

            <Field data-invalid={!!errors.maxInstallments}>
              <FieldLabel htmlFor="item-max-installments">Can only be split into</FieldLabel>
              <Input
                id="item-max-installments"
                type="number"
                step="1"
                min="1"
                inputMode="numeric"
                placeholder="No restriction, e.g. leave blank"
                {...form.register("maxInstallments", { setValueAs: emptyToNull })}
              />
              {errors.maxInstallments && <FieldError>{errors.maxInstallments.message}</FieldError>}
            </Field>

            <details
              open={moreOptionsOpen}
              onToggle={(event) => setMoreOptionsOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer list-none text-xs text-muted-foreground underline-offset-2 hover:underline">
                More options
              </summary>
              <div className="mt-3 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field data-invalid={!!errors.earliestPurchaseDate}>
                    <FieldLabel htmlFor="item-earliest">Not before</FieldLabel>
                    <Input
                      id="item-earliest"
                      type="date"
                      {...form.register("earliestPurchaseDate", { setValueAs: emptyToNull })}
                    />
                    {errors.earliestPurchaseDate && (
                      <FieldError>{errors.earliestPurchaseDate.message}</FieldError>
                    )}
                  </Field>
                  <Controller
                    control={form.control}
                    name="priority"
                    render={({ field }) => (
                      <Field>
                        <FieldLabel>Priority</FieldLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PRIORITIES.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
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
                  <FieldLabel htmlFor="item-notes">Notes</FieldLabel>
                  <Textarea id="item-notes" rows={2} placeholder="Optional" {...form.register("notes")} />
                </Field>
              </div>
            </details>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Add item
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
