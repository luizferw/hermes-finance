"use client";

import * as React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { todayIso } from "@kosh/domain";
import { createTransaction } from "@/modules/transactions/mutations";
import { createTransactionSchema } from "@/modules/transactions/validators";
import type { CategoryOption } from "@/components/transactions/category-picker";
import type { AccountOption } from "./transactions-client";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export function NewTransactionDialog({
  open,
  onOpenChange,
  accounts,
  categories,
  tags,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountOption[];
  categories: CategoryOption[];
  tags: Array<{ id: string; name: string }>;
  onCreated: () => void;
}) {
  const form = useForm({
    resolver: zodResolver(createTransactionSchema),
    defaultValues: {
      type: "expense",
      date: todayIso(),
      accountId: accounts[0]?.id ?? "",
      amount: undefined as unknown as number,
      description: "",
      categoryId: null,
      tagIds: [],
    },
  });
  const type = form.watch("type");

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createTransaction(values);
      toast.success("Transaction added");
      form.reset({
        type: values.type,
        date: values.date,
        accountId: values.accountId,
        amount: undefined as unknown as number,
        description: "",
        categoryId: null,
        tagIds: [],
      });
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    }
  });

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New transaction</DialogTitle>
          <DialogDescription>
            Recorded as posted — it counts immediately.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <Tabs value={field.value} onValueChange={field.onChange}>
                  <TabsList className="w-full">
                    <TabsTrigger value="expense" className="flex-1">
                      Expense
                    </TabsTrigger>
                    <TabsTrigger value="income" className="flex-1">
                      Income
                    </TabsTrigger>
                    <TabsTrigger value="transfer" className="flex-1">
                      Transfer
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="tx-amount">Amount</FieldLabel>
                <Input
                  id="tx-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  {...form.register("amount")}
                />
                {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
              </Field>
              <Field data-invalid={!!errors.date}>
                <FieldLabel htmlFor="tx-date">Date</FieldLabel>
                <Input id="tx-date" type="date" {...form.register("date")} />
                {errors.date && <FieldError>{errors.date.message}</FieldError>}
              </Field>
            </div>

            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="tx-description">Description</FieldLabel>
              <Input
                id="tx-description"
                placeholder={
                  type === "transfer" ? "e.g. Savings transfer" : "e.g. Groceries at DMart"
                }
                {...form.register("description")}
              />
              {errors.description && (
                <FieldError>{errors.description.message}</FieldError>
              )}
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <Field data-invalid={!!errors.accountId}>
                    <FieldLabel>{type === "transfer" ? "From" : "Account"}</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Pick an account" />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.accountId && (
                      <FieldError>{errors.accountId.message}</FieldError>
                    )}
                  </Field>
                )}
              />
              {type === "transfer" ? (
                <Controller
                  control={form.control}
                  name="transferAccountId"
                  render={({ field }) => (
                    <Field data-invalid={!!errors.transferAccountId}>
                      <FieldLabel>To</FieldLabel>
                      <Select
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Destination" />
                        </SelectTrigger>
                        <SelectContent>
                          {accounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {errors.transferAccountId && (
                        <FieldError>{errors.transferAccountId.message}</FieldError>
                      )}
                    </Field>
                  )}
                />
              ) : (
                <Controller
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <Field>
                      <FieldLabel>Category</FieldLabel>
                      <Select
                        value={field.value ?? "none"}
                        onValueChange={(v) => field.onChange(v === "none" ? null : v)}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Optional" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No category</SelectItem>
                          {categories.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                />
              )}
            </div>

            <Controller
              control={form.control}
              name="tagIds"
              render={({ field }) => (
                <Field>
                  <FieldLabel>Tags</FieldLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No tags yet — they’re created in settings or by rules.
                      </p>
                    )}
                    {tags.map((tag) => {
                      const active = field.value?.includes(tag.id) ?? false;
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() =>
                            field.onChange(
                              active
                                ? (field.value ?? []).filter((id) => id !== tag.id)
                                : [...(field.value ?? []), tag.id],
                            )
                          }
                          className={
                            active
                              ? "rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-xs text-primary"
                              : "rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                          }
                        >
                          #{tag.name}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              )}
            />

            <Field>
              <FieldLabel htmlFor="tx-notes">Notes</FieldLabel>
              <Textarea
                id="tx-notes"
                rows={2}
                placeholder="Optional"
                {...form.register("notes")}
              />
            </Field>

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Add transaction
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
