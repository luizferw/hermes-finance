"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { minorToMajor, todayIso } from "@kosh/domain";
import { listBillPaymentCandidates, markBillPaid } from "@/modules/bills/mutations";
import { markBillPaidFormSchema } from "@/modules/bills/validators";
import { formatAbsAmount, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
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
import { Spinner } from "@/components/ui/spinner";

export interface PayableBill {
  id: string;
  name: string;
  expectedAmountMinor: number;
  currencyCode: string;
  accountId: string | null;
}

type Candidate = {
  id: string;
  date: string;
  amountMinor: number;
  description: string;
  merchant: string | null;
};

/**
 * Variable bills (PRD §9.10) project from whatever transaction really paid
 * them last, not the typed estimate — so marking one paid must record that
 * real payment: either link an existing unlinked expense, or type what was
 * actually paid so a transaction gets created for it.
 */
export function MarkBillPaidDialog({
  bill,
  open,
  onOpenChange,
}: {
  bill: PayableBill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = React.useState(false);

  const form = useForm({
    resolver: zodResolver(markBillPaidFormSchema),
    defaultValues: {
      transactionId: undefined as string | undefined,
      amount: bill.accountId
        ? minorToMajor(bill.expectedAmountMinor, bill.currencyCode)
        : undefined,
      paymentDate: todayIso(),
    },
  });
  const errors = form.formState.errors;
  const transactionId = form.watch("transactionId");

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      transactionId: undefined,
      amount: bill.accountId
        ? minorToMajor(bill.expectedAmountMinor, bill.currencyCode)
        : undefined,
      paymentDate: todayIso(),
    });
    setLoadingCandidates(true);
    listBillPaymentCandidates(bill.id)
      .then(setCandidates)
      .catch(() => toast.error("Could not load candidate transactions"))
      .finally(() => setLoadingCandidates(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill.id]);

  function selectCandidate(id: string) {
    const next = transactionId === id ? undefined : id;
    form.setValue("transactionId", next, { shouldValidate: true });
    if (next) form.setValue("amount", undefined, { shouldValidate: true });
  }

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await markBillPaid({ billId: bill.id, ...values });
      toast.success(`${bill.name} marked paid`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark bill paid");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark &quot;{bill.name}&quot; paid</DialogTitle>
          <DialogDescription>
            This bill&apos;s amount varies, so the next forecast follows what was
            really paid — pick the transaction that paid it, or enter the amount.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            {loadingCandidates && (
              <p className="text-xs text-muted-foreground">Loading transactions…</p>
            )}
            {!loadingCandidates && candidates.length > 0 && (
              <Field>
                <FieldLabel>Pick a transaction</FieldLabel>
                <ul className="max-h-48 divide-y divide-dashed overflow-y-auto rounded-lg border">
                  {candidates.map((candidate) => {
                    const selected = transactionId === candidate.id;
                    return (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          onClick={() => selectCandidate(candidate.id)}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted",
                            selected && "bg-muted",
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {candidate.merchant || candidate.description}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatDate(candidate.date)}
                            </span>
                          </span>
                          <span className="font-amount shrink-0 text-sm">
                            {formatAbsAmount(candidate.amountMinor, bill.currencyCode)}
                          </span>
                          {selected && (
                            <HugeiconsIcon
                              icon={Tick02Icon}
                              className="size-4 shrink-0 text-primary"
                            />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Field>
            )}

            <p className="text-xs text-muted-foreground">
              {!bill.accountId
                ? "This bill has no account, so an amount can't be recorded as a transaction — pick a transaction above instead."
                : candidates.length > 0
                  ? "Or enter what was actually paid:"
                  : "Enter what was actually paid:"}
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="mark-paid-amount">Amount paid</FieldLabel>
                <Input
                  id="mark-paid-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  disabled={!!transactionId || !bill.accountId}
                  {...form.register("amount", {
                    setValueAs: (v) => (v === "" ? undefined : Number(v)),
                    onChange: () => {
                      if (transactionId) form.setValue("transactionId", undefined);
                    },
                  })}
                />
                {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.paymentDate}>
                <FieldLabel htmlFor="mark-paid-date">Payment date</FieldLabel>
                <Input
                  id="mark-paid-date"
                  type="date"
                  disabled={!!transactionId || !bill.accountId}
                  {...form.register("paymentDate", {
                    setValueAs: (v) => (v === "" ? undefined : v),
                  })}
                />
                {errors.paymentDate && (
                  <FieldError>{errors.paymentDate.message}</FieldError>
                )}
              </Field>
            </div>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Mark paid
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
