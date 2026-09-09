"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createFinancialReserve } from "@/modules/finance/mutations";
import { createFinancialReserveSchema } from "@/modules/finance/validators";
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

/**
 * A HARD reserve is a floor safe-to-spend never crosses; a SOFT one only
 * warns when a simulated purchase would eat into it. The distinction is the
 * whole point of the field, so it is asked plainly rather than defaulted.
 */
export function NewReserveDialog({ defaultCurrency }: { defaultCurrency: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createFinancialReserveSchema),
    defaultValues: {
      name: "",
      kind: "hard" as const,
      amount: undefined as unknown as number,
      currencyCode: defaultCurrency,
      isActive: true,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createFinancialReserve(values);
      toast.success(`${values.name} added`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the reserve");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          Add reserve
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a protected reserve</DialogTitle>
          <DialogDescription>
            Hard reserves are a floor safe-to-spend never crosses. Soft ones
            only get a warning when a simulated purchase would eat into them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="reserve-name">Name</FieldLabel>
              <Input id="reserve-name" placeholder="e.g. Emergency fund" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.kind}>
              <FieldLabel htmlFor="reserve-kind">Kind</FieldLabel>
              <Controller
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="reserve-kind">
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
              <FieldLabel htmlFor="reserve-amount">Amount</FieldLabel>
              <Input
                id="reserve-amount"
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
              Add reserve
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
