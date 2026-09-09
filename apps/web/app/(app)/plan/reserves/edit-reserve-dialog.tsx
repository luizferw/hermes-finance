"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { minorToMajor } from "@kosh/domain";
import { updateFinancialReserve } from "@/modules/finance/mutations";
import { updateFinancialReserveSchema } from "@/modules/finance/validators";
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
import type { ReserveRow } from "./reserve-list";

/**
 * A HARD reserve is a floor safe-to-spend never crosses; a SOFT one only
 * warns when a simulated purchase would eat into it — same wording as
 * NewReserveDialog, since the distinction matters just as much on edit.
 */
export function EditReserveDialog({
  reserve,
  open,
  onOpenChange,
}: {
  reserve: ReserveRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(updateFinancialReserveSchema),
    defaultValues: {
      name: reserve.name,
      kind: reserve.kind,
      amount: minorToMajor(reserve.amountMinor, reserve.currencyCode),
    },
  });
  const errors = form.formState.errors;

  // Re-seed the form whenever a different reserve is opened for editing.
  React.useEffect(() => {
    if (open) {
      form.reset({
        name: reserve.name,
        kind: reserve.kind,
        amount: minorToMajor(reserve.amountMinor, reserve.currencyCode),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reserve.id]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updateFinancialReserve(reserve.id, values);
      toast.success(`${values.name ?? reserve.name} updated`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the reserve");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit reserve</DialogTitle>
          <DialogDescription>
            Hard reserves are a floor safe-to-spend never crosses. Soft ones
            only get a warning when a simulated purchase would eat into them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-reserve-name">Name</FieldLabel>
              <Input
                id="edit-reserve-name"
                placeholder="e.g. Emergency fund"
                {...form.register("name")}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.kind}>
              <FieldLabel htmlFor="edit-reserve-kind">Kind</FieldLabel>
              <Controller
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="edit-reserve-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hard">Hard — never violated</SelectItem>
                      <SelectItem value="soft">Soft — warns only</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.kind && <FieldError>{errors.kind.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.amount}>
              <FieldLabel htmlFor="edit-reserve-amount">Amount</FieldLabel>
              <Input
                id="edit-reserve-amount"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                placeholder="0.00"
                {...form.register("amount")}
              />
              {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
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
