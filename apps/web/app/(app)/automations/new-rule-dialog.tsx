"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  useForm,
  Controller,
  type UseFormRegisterReturn,
} from "react-hook-form";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { majorToMinor } from "@kosh/domain";
import { createRule } from "@/modules/rules/mutations";
import type {
  RuleActionInput,
  RuleConditionInput,
} from "@/modules/rules/validators";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

const CONDITION_OPTIONS = [
  { value: "description_contains", label: "Description contains" },
  { value: "raw_text_contains", label: "Raw text contains" },
  { value: "transaction_type_is", label: "Transaction type is" },
  { value: "account_is", label: "Account is" },
  { value: "amount_greater_than", label: "Amount greater than" },
  { value: "amount_less_than", label: "Amount less than" },
  { value: "amount_equals", label: "Amount equals" },
] as const;

const ACTION_OPTIONS = [
  { value: "set_category", label: "Set category" },
  { value: "add_tag", label: "Add tag" },
  { value: "rename_merchant", label: "Rename merchant" },
  { value: "mark_reviewed", label: "Mark reviewed" },
] as const;

interface RuleForm {
  name: string;
  description: string;
  conditionField: RuleConditionInput["field"];
  conditionValue: string;
  actionType: RuleActionInput["type"];
  actionValue: string;
  runOnImport: boolean;
}

export function NewRuleDialog({
  accounts,
  categories,
  tags,
  currencyCode,
  defaultOpen = false,
  defaultContains,
  defaultCategoryId,
}: {
  accounts: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  currencyCode: string;
  defaultOpen?: boolean;
  defaultContains?: string;
  defaultCategoryId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const form = useForm<RuleForm>({
    defaultValues: {
      name: defaultContains ? `Categorize ${defaultContains}` : "",
      description: "",
      conditionField: "description_contains",
      conditionValue: defaultContains ?? "",
      actionType: defaultCategoryId ? "set_category" : "mark_reviewed",
      actionValue: defaultCategoryId ?? "",
      runOnImport: true,
    },
  });
  const conditionField = form.watch("conditionField");
  const actionType = form.watch("actionType");

  function normalizedCondition(values: RuleForm): RuleConditionInput {
    const value = values.conditionValue.trim();
    const amountField =
      values.conditionField === "amount_equals" ||
      values.conditionField === "amount_greater_than" ||
      values.conditionField === "amount_less_than";
    return {
      field: values.conditionField,
      value: amountField
        ? String(majorToMinor(Number(value), currencyCode))
        : value,
    };
  }

  function normalizedAction(values: RuleForm): RuleActionInput {
    return {
      type: values.actionType,
      value:
        values.actionType === "mark_reviewed"
          ? null
          : values.actionValue.trim() || null,
    };
  }

  const onSubmit = form.handleSubmit(async (values) => {
    if (!values.name.trim()) {
      form.setError("name", { message: "Name is required" });
      return;
    }
    if (!values.conditionValue.trim()) {
      form.setError("conditionValue", { message: "Condition value is required" });
      return;
    }
    if (values.actionType !== "mark_reviewed" && !values.actionValue.trim()) {
      form.setError("actionValue", { message: "Action value is required" });
      return;
    }

    try {
      await createRule({
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        matchAll: true,
        runOnImport: values.runOnImport,
        conditions: [normalizedCondition(values)],
        actions: [normalizedAction(values)],
      });
      toast.success("Rule created");
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create rule");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <HugeiconsIcon icon={PlusSignIcon} />
          New rule
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New automation rule</DialogTitle>
          <DialogDescription>
            Match imported transactions and apply one cleanup action.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.name}>
              <FieldLabel htmlFor="rule-name">Name</FieldLabel>
              <Input
                id="rule-name"
                placeholder="e.g. Swiggy to Eating Out"
                {...form.register("name")}
              />
              {form.formState.errors.name && (
                <FieldError>{form.formState.errors.name.message}</FieldError>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-description">Description</FieldLabel>
              <Input
                id="rule-description"
                placeholder="Optional"
                {...form.register("description")}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="conditionField"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>When</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CONDITION_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />

              <ConditionValueField
                field={conditionField}
                accounts={accounts}
                register={form.register("conditionValue")}
                value={form.watch("conditionValue")}
                onChange={(value) => form.setValue("conditionValue", value)}
                error={form.formState.errors.conditionValue?.message}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="actionType"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Then</FieldLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        form.setValue("actionValue", "");
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTION_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />

              <ActionValueField
                type={actionType}
                categories={categories}
                tags={tags}
                value={form.watch("actionValue")}
                onChange={(value) => form.setValue("actionValue", value)}
                register={form.register("actionValue")}
                error={form.formState.errors.actionValue?.message}
              />
            </div>

            <Controller
              control={form.control}
              name="runOnImport"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <span>
                    <FieldLabel htmlFor="rule-run-on-import">
                      Run on new imports
                    </FieldLabel>
                    <FieldDescription>
                      Also runs when CSV imports are committed.
                    </FieldDescription>
                  </span>
                  <Switch
                    id="rule-run-on-import"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </Field>
              )}
            />

            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />}
              Create rule
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConditionValueField({
  field,
  accounts,
  value,
  onChange,
  register,
  error,
}: {
  field: RuleConditionInput["field"];
  accounts: Array<{ id: string; name: string }>;
  value: string;
  onChange: (value: string) => void;
  register: UseFormRegisterReturn;
  error?: string;
}) {
  if (field === "account_is") {
    return (
      <Field data-invalid={!!error}>
        <FieldLabel>Value</FieldLabel>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Pick account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    );
  }

  if (field === "transaction_type_is") {
    return (
      <Field data-invalid={!!error}>
        <FieldLabel>Value</FieldLabel>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Pick type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="expense">Expense</SelectItem>
            <SelectItem value="income">Income</SelectItem>
            <SelectItem value="transfer">Transfer</SelectItem>
          </SelectContent>
        </Select>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    );
  }

  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor="rule-condition-value">Value</FieldLabel>
      <Input
        id="rule-condition-value"
        type={field.startsWith("amount_") ? "number" : "text"}
        step="0.01"
        inputMode={field.startsWith("amount_") ? "decimal" : undefined}
        placeholder={field.startsWith("amount_") ? "0.00" : "e.g. swiggy"}
        {...register}
      />
      {field.startsWith("amount_") && (
        <FieldDescription>Enter major units; the rule stores minor units.</FieldDescription>
      )}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}

function ActionValueField({
  type,
  categories,
  tags,
  value,
  onChange,
  register,
  error,
}: {
  type: RuleActionInput["type"];
  categories: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  value: string;
  onChange: (value: string) => void;
  register: UseFormRegisterReturn;
  error?: string;
}) {
  if (type === "mark_reviewed") {
    return (
      <Field>
        <FieldLabel>Value</FieldLabel>
        <div className="flex h-7 items-center rounded-md border border-dashed px-2 text-xs text-muted-foreground">
          No value needed
        </div>
      </Field>
    );
  }

  if (type === "set_category") {
    return (
      <Field data-invalid={!!error}>
        <FieldLabel>Category</FieldLabel>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Pick category" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    );
  }

  if (type === "add_tag") {
    return (
      <Field data-invalid={!!error}>
        <FieldLabel>Tag</FieldLabel>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Pick tag" />
          </SelectTrigger>
          <SelectContent>
            {tags.map((tag) => (
              <SelectItem key={tag.id} value={tag.id}>
                #{tag.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    );
  }

  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor="rule-action-value">Value</FieldLabel>
      <Input
        id="rule-action-value"
        placeholder="e.g. Swiggy"
        {...register}
      />
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}
