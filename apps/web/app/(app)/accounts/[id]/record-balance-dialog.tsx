"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { upsertBalanceSnapshot } from "@/modules/finance/mutations";
import { upsertBalanceSnapshotSchema } from "@/modules/finance/validators";
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

/**
 * Records an observed balance for one date, independent of the ledger.
 *
 * Without this, `balance_snapshots` stays empty for every real account, and
 * with it staleness (PRD R8/§62) has no signal to work from — every balance
 * silently falls back to whatever the ledger derives, never flagged as old.
 */
export function RecordBalanceDialog({ accountId, todayIso }: { accountId: string; todayIso: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(upsertBalanceSnapshotSchema),
    defaultValues: {
      accountId,
      amount: undefined as unknown as number,
      observedAt: todayIso,
      source: "manual",
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await upsertBalanceSnapshot(values);
      toast.success("Balance recorded");
      form.reset({ accountId, amount: undefined as unknown as number, observedAt: todayIso, source: "manual" });
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the balance");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} />
          Record balance
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record an observed balance</DialogTitle>
          <DialogDescription>
            The exact balance shown by the bank on a given date. This is what
            lets the app know how fresh a number is, separate from whatever
            the ledger derives.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.amount}>
              <FieldLabel htmlFor="snapshot-amount">Balance</FieldLabel>
              <Input
                id="snapshot-amount"
                type="number"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                {...form.register("amount")}
              />
              {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.observedAt}>
              <FieldLabel htmlFor="snapshot-date">Observed on</FieldLabel>
              <Input id="snapshot-date" type="date" {...form.register("observedAt")} />
              {errors.observedAt && <FieldError>{errors.observedAt.message}</FieldError>}
            </Field>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Record balance
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
