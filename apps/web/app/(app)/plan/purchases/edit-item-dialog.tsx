"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { minorToMajor } from "@kosh/domain";
import { updatePurchaseItem } from "@/modules/finance/mutations";
import { updatePurchaseItemSchema } from "@/modules/finance/validators";
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
  { value: "purchased", label: "Purchased" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export interface EditablePurchaseItem {
  id: string;
  name: string;
  priority: "must_have" | "high" | "medium" | "low" | "optional";
  estimatedPriceMinor: number;
  actualPriceMinor: number | null;
  earliestPurchaseDate: string | null;
  deadline: string | null;
  status: "idea" | "planned" | "ready" | "purchased" | "cancelled";
  notes: string | null;
}

/** Items carry no currency of their own — they are priced in the plan's. */
export function EditPurchaseItemDialog({
  item,
  currencyCode,
  open,
  onOpenChange,
}: {
  item: EditablePurchaseItem;
  currencyCode: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(updatePurchaseItemSchema),
    defaultValues: {
      name: item.name,
      priority: item.priority,
      estimatedPrice: minorToMajor(item.estimatedPriceMinor, currencyCode),
      actualPrice: item.actualPriceMinor != null ? minorToMajor(item.actualPriceMinor, currencyCode) : null,
      earliestPurchaseDate: item.earliestPurchaseDate,
      deadline: item.deadline,
      status: item.status,
      notes: item.notes ?? "",
    },
  });
  const errors = form.formState.errors;

  // Re-seed the form whenever a different item is opened for editing.
  React.useEffect(() => {
    if (open) {
      form.reset({
        name: item.name,
        priority: item.priority,
        estimatedPrice: minorToMajor(item.estimatedPriceMinor, currencyCode),
        actualPrice: item.actualPriceMinor != null ? minorToMajor(item.actualPriceMinor, currencyCode) : null,
        earliestPurchaseDate: item.earliestPurchaseDate,
        deadline: item.deadline,
        status: item.status,
        notes: item.notes ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updatePurchaseItem(item.id, values);
      toast.success(`${values.name ?? item.name} updated`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the item");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit item</DialogTitle>
          <DialogDescription>
            Prices are in {currencyCode}, the plan&apos;s currency.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-item-name">Name</FieldLabel>
              <Input id="edit-item-name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.estimatedPrice}>
                <FieldLabel htmlFor="edit-item-price">Estimated price</FieldLabel>
                <Input
                  id="edit-item-price"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  {...form.register("estimatedPrice")}
                />
                {errors.estimatedPrice && (
                  <FieldError>{errors.estimatedPrice.message}</FieldError>
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

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.actualPrice}>
                <FieldLabel htmlFor="edit-item-actual">Actual price</FieldLabel>
                <Input
                  id="edit-item-actual"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="Optional"
                  {...form.register("actualPrice", { setValueAs: emptyToNull })}
                />
                {errors.actualPrice && <FieldError>{errors.actualPrice.message}</FieldError>}
              </Field>
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
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.earliestPurchaseDate}>
                <FieldLabel htmlFor="edit-item-earliest">Not before</FieldLabel>
                <Input
                  id="edit-item-earliest"
                  type="date"
                  {...form.register("earliestPurchaseDate", { setValueAs: emptyToNull })}
                />
                {errors.earliestPurchaseDate && (
                  <FieldError>{errors.earliestPurchaseDate.message}</FieldError>
                )}
              </Field>
              <Field data-invalid={!!errors.deadline}>
                <FieldLabel htmlFor="edit-item-deadline">Needed by</FieldLabel>
                <Input
                  id="edit-item-deadline"
                  type="date"
                  {...form.register("deadline", { setValueAs: emptyToNull })}
                />
                {errors.deadline && <FieldError>{errors.deadline.message}</FieldError>}
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="edit-item-notes">Notes</FieldLabel>
              <Textarea
                id="edit-item-notes"
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
