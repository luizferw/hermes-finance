"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { reconcileBillingCycle } from "@/modules/finance/mutations";
import { reconcileBillingCycleSchema } from "@/modules/finance/validators";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Confirms a cycle against the real statement (PRD §29).
 *
 * The mutation itself computes the discrepancy — sum of what the system
 * billed to this cycle versus the total typed in here — and forces
 * `needs_review` when they don't match, no matter what status was asked for.
 * A mismatch is shown back immediately rather than silently accepted.
 */
export function ReconcileCycleDialog({
  cycleId,
  statementMonth,
  currencyCode,
}: {
  cycleId: string;
  statementMonth: string;
  currencyCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<{ status: string; discrepancyMinor: number } | null>(null);
  const form = useForm({
    resolver: zodResolver(reconcileBillingCycleSchema),
    defaultValues: { confirmedTotal: undefined as unknown as number, status: "closed" as const },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const outcome = await reconcileBillingCycle(cycleId, values);
      setResult({ status: outcome.status, discrepancyMinor: outcome.discrepancyMinor });
      if (outcome.status === "needs_review") {
        toast.warning("Doesn't match what was billed — flagged for review.");
      } else {
        toast.success("Reconciled");
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reconcile the statement");
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setResult(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Reconcile ${statementMonth}`}>
          <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reconcile statement</DialogTitle>
          <DialogDescription>
            Enter the total from the real statement. If it doesn&apos;t match
            what this cycle already billed, the cycle is marked for review
            instead of being accepted as-is.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.confirmedTotal}>
              <FieldLabel htmlFor="reconcile-total">Statement total</FieldLabel>
              <Input
                id="reconcile-total"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                placeholder="0.00"
                {...form.register("confirmedTotal")}
              />
              {errors.confirmedTotal && <FieldError>{errors.confirmedTotal.message}</FieldError>}
            </Field>

            {result && (
              <FieldDescription
                className={result.status === "needs_review" ? "text-destructive" : "text-foreground"}
              >
                {result.status === "needs_review"
                  ? `Off by ${formatMoney(Math.abs(result.discrepancyMinor), currencyCode)} — flagged for review.`
                  : "Matches what this cycle billed."}
              </FieldDescription>
            )}

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Reconcile
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
