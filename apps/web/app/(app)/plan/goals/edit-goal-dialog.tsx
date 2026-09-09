"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { minorToMajor } from "@kosh/domain";
import { updateGoal } from "@/modules/goals/mutations";
import { updateGoalSchema } from "@/modules/goals/validators";
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

export interface EditableGoal {
  id: string;
  name: string;
  targetAmountMinor: number;
  currencyCode: string;
  accountId: string | null;
  targetDate: string | null;
}

/**
 * Fixes what was wrong at creation — name, target, currency, linked account,
 * target date — without touching the saved balance. `currentAmountMinor` has
 * no field here: `contributeToGoal` owns it.
 */
export function EditGoalDialog({
  goal,
  accounts,
}: {
  goal: EditableGoal;
  accounts: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(updateGoalSchema),
    defaultValues: {
      name: goal.name,
      targetAmount: minorToMajor(goal.targetAmountMinor, goal.currencyCode),
      currencyCode: goal.currencyCode,
      accountId: goal.accountId,
      targetDate: goal.targetDate,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updateGoal(goal.id, values);
      toast.success(`${values.name ?? goal.name} updated`);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the goal");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Edit goal">
          <HugeiconsIcon icon={PencilEdit02Icon} />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit goal</DialogTitle>
          <DialogDescription>
            Saved progress only changes through a contribution — edit the
            target, currency, account, or date here.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="edit-goal-name">Name</FieldLabel>
              <Input id="edit-goal-name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.targetAmount}>
                <FieldLabel htmlFor="edit-goal-target">Target amount</FieldLabel>
                <Input
                  id="edit-goal-target"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  {...form.register("targetAmount")}
                />
                {errors.targetAmount && (
                  <FieldError>{errors.targetAmount.message}</FieldError>
                )}
              </Field>
              <Field data-invalid={!!errors.currencyCode}>
                <FieldLabel htmlFor="edit-goal-currency">Currency</FieldLabel>
                <Input
                  id="edit-goal-currency"
                  maxLength={3}
                  {...form.register("currencyCode")}
                />
                {errors.currencyCode && (
                  <FieldError>{errors.currencyCode.message}</FieldError>
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
                <FieldLabel htmlFor="edit-goal-date">Target date</FieldLabel>
                <Input
                  id="edit-goal-date"
                  type="date"
                  {...form.register("targetDate", {
                    setValueAs: (v) => (v === "" ? null : v),
                  })}
                />
              </Field>
            </div>

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
