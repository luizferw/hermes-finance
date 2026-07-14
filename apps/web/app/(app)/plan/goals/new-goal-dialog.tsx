"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { createGoal } from "@/modules/goals/mutations";
import { createGoalSchema } from "@/modules/goals/validators";
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

export function NewGoalDialog({
  accounts,
}: {
  accounts: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(createGoalSchema),
    defaultValues: {
      name: "",
      targetAmount: undefined as unknown as number,
      currentAmount: 0,
      currencyCode: "INR",
      accountId: null,
      targetDate: null,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createGoal(values);
      toast.success(`${values.name} created`);
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create goal");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          New goal
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New savings goal</DialogTitle>
          <DialogDescription>
            Track progress toward a target amount and optional date.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="goal-name">Name</FieldLabel>
              <Input
                id="goal-name"
                placeholder="e.g. Emergency fund"
                {...form.register("name")}
              />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.targetAmount}>
                <FieldLabel htmlFor="goal-target">Target amount</FieldLabel>
                <Input
                  id="goal-target"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("targetAmount")}
                />
                {errors.targetAmount && (
                  <FieldError>{errors.targetAmount.message}</FieldError>
                )}
              </Field>
              <Field data-invalid={!!errors.currentAmount}>
                <FieldLabel htmlFor="goal-current">Saved now</FieldLabel>
                <Input
                  id="goal-current"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  {...form.register("currentAmount")}
                />
                {errors.currentAmount && (
                  <FieldError>{errors.currentAmount.message}</FieldError>
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Linked account</FieldLabel>
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
              <Field>
                <FieldLabel htmlFor="goal-date">Target date</FieldLabel>
                <Input id="goal-date" type="date" {...form.register("targetDate")} />
              </Field>
            </div>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create goal
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
