"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { updateAccount } from "@/modules/accounts/mutations";
import { updateAccountSchema } from "@/modules/accounts/validators";
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
import { Switch } from "@/components/ui/switch";

export interface EditableAccount {
  id: string;
  name: string;
  currencyCode: string;
  institution: string | null;
  limitMinor: number | null;
  includeInNetWorth: boolean;
  isArchived: boolean;
}

/**
 * Fixes what was wrong at creation — name, institution, currency, limit —
 * without touching what the ledger depends on. `updateAccount` itself never
 * writes `type`, opening balance or the running balance, so there is no form
 * field here that can quietly corrupt account history.
 */
export function EditAccountDialog({ account }: { account: EditableAccount }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const form = useForm({
    resolver: zodResolver(updateAccountSchema),
    defaultValues: {
      name: account.name,
      currencyCode: account.currencyCode,
      institution: account.institution ?? "",
      limit: account.limitMinor !== null ? account.limitMinor / 100 : undefined,
      includeInNetWorth: account.includeInNetWorth,
      isArchived: account.isArchived,
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updateAccount(account.id, values);
      toast.success(`${values.name ?? account.name} updated`);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the account");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <HugeiconsIcon icon={PencilEdit02Icon} />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>
            Type and opening balance are fixed once an account exists — the
            forecast depends on them staying put.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="account-name">Name</FieldLabel>
              <Input id="account-name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.institution}>
              <FieldLabel htmlFor="account-institution">Institution</FieldLabel>
              <Input id="account-institution" {...form.register("institution")} />
              {errors.institution && <FieldError>{errors.institution.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.currencyCode}>
              <FieldLabel htmlFor="account-currency">Currency</FieldLabel>
              <Input id="account-currency" maxLength={3} {...form.register("currencyCode")} />
              {errors.currencyCode && <FieldError>{errors.currencyCode.message}</FieldError>}
            </Field>

            <Field data-invalid={!!errors.limit}>
              <FieldLabel htmlFor="account-limit">Limit / principal</FieldLabel>
              <Input
                id="account-limit"
                type="number"
                step="0.01"
                inputMode="decimal"
                {...form.register("limit")}
              />
              <FieldDescription>Leave blank if this account has none.</FieldDescription>
              {errors.limit && <FieldError>{errors.limit.message}</FieldError>}
            </Field>

            <Field orientation="horizontal">
              <FieldLabel htmlFor="account-net-worth">Include in net worth</FieldLabel>
              <Switch
                id="account-net-worth"
                checked={form.watch("includeInNetWorth")}
                onCheckedChange={(checked) => form.setValue("includeInNetWorth", checked)}
              />
            </Field>

            <Field orientation="horizontal">
              <FieldLabel htmlFor="account-archived">Archived</FieldLabel>
              <Switch
                id="account-archived"
                checked={form.watch("isArchived")}
                onCheckedChange={(checked) => form.setValue("isArchived", checked)}
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
