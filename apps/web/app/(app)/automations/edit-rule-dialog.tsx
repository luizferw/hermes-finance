"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  useFieldArray,
  useForm,
  Controller,
  type UseFormRegisterReturn,
} from "react-hook-form";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, PencilEdit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { majorToMinor, minorToMajor } from "@kosh/domain";
import { updateRule } from "@/modules/rules/mutations";
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

/** Mirrors `updateRuleSchema.conditions.max(10)`. */
const MAX_CONDITIONS = 10;

interface ConditionRow {
  field: RuleConditionInput["field"];
  value: string;
}

interface RuleForm {
  name: string;
  description: string;
  conditions: ConditionRow[];
  matchAll: boolean;
  actionType: RuleActionInput["type"];
  actionValue: string;
  runOnImport: boolean;
}

export interface EditableRule {
  id: string;
  name: string;
  description: string | null;
  matchAll: boolean;
  runOnImport: boolean;
  conditions: Array<{ field: string; value: string }>;
  actions: Array<{ type: string; value: string | null }>;
}

/** Amount conditions are stored as minor-unit strings; show major units in the form. */
function conditionToRow(
  condition: EditableRule["conditions"][number],
  currencyCode: string,
): ConditionRow {
  const field = condition.field as RuleConditionInput["field"];
  return {
    field,
    value: field.startsWith("amount_")
      ? String(minorToMajor(Number(condition.value), currencyCode))
      : condition.value,
  };
}

export function EditRuleDialog({
  rule,
  accounts,
  categories,
  tags,
  currencyCode,
}: {
  rule: EditableRule;
  accounts: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  currencyCode: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const firstAction = rule.actions[0];
  const form = useForm<RuleForm>({
    defaultValues: {
      name: rule.name,
      description: rule.description ?? "",
      conditions: rule.conditions.map((c) => conditionToRow(c, currencyCode)),
      matchAll: rule.matchAll,
      actionType: firstAction?.type as RuleActionInput["type"] ?? "mark_reviewed",
      actionValue: firstAction?.value ?? "",
      runOnImport: rule.runOnImport,
    },
  });
  const conditions = useFieldArray({ control: form.control, name: "conditions" });
  const conditionRows = form.watch("conditions");
  const actionType = form.watch("actionType");

  function normalizedCondition(row: ConditionRow): RuleConditionInput {
    const value = row.value.trim();
    return {
      field: row.field,
      value: row.field.startsWith("amount_")
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
    const blank = values.conditions.findIndex((c) => !c.value.trim());
    if (blank !== -1) {
      form.setError(`conditions.${blank}.value`, {
        message: "Condition value is required",
      });
      return;
    }
    if (values.actionType !== "mark_reviewed" && !values.actionValue.trim()) {
      form.setError("actionValue", { message: "Action value is required" });
      return;
    }

    try {
      await updateRule(rule.id, {
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        matchAll: values.matchAll,
        runOnImport: values.runOnImport,
        conditions: values.conditions.map(normalizedCondition),
        actions: [normalizedAction(values)],
      });
      toast.success("Rule updated");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update rule");
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset to the rule's current values whenever the dialog reopens,
        // discarding any unsaved edits from a previous open.
        if (next) {
          form.reset({
            name: rule.name,
            description: rule.description ?? "",
            conditions: rule.conditions.map((c) => conditionToRow(c, currencyCode)),
            matchAll: rule.matchAll,
            actionType: firstAction?.type as RuleActionInput["type"] ?? "mark_reviewed",
            actionValue: firstAction?.value ?? "",
            runOnImport: rule.runOnImport,
          });
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Edit ${rule.name}`}>
          <HugeiconsIcon icon={PencilEdit02Icon} />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit automation rule</DialogTitle>
          <DialogDescription>
            Match imported transactions on one or more conditions, then apply a
            cleanup action.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.name}>
              <FieldLabel htmlFor="edit-rule-name">Name</FieldLabel>
              <Input
                id="edit-rule-name"
                placeholder="e.g. Swiggy to Eating Out"
                {...form.register("name")}
              />
              {form.formState.errors.name && (
                <FieldError>{form.formState.errors.name.message}</FieldError>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="edit-rule-description">Description</FieldLabel>
              <Input
                id="edit-rule-description"
                placeholder="Optional"
                {...form.register("description")}
              />
            </Field>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel>When</FieldLabel>
                {conditions.fields.length > 1 && (
                  <Controller
                    control={form.control}
                    name="matchAll"
                    render={({ field }) => (
                      <Select
                        value={field.value ? "all" : "any"}
                        onValueChange={(value) => field.onChange(value === "all")}
                      >
                        <SelectTrigger size="sm" className="w-[9.5rem]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Match all of these</SelectItem>
                          <SelectItem value="any">Match any of these</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </div>

              {conditions.fields.map((row, index) => (
                <div key={row.id} className="flex items-end gap-2">
                  <div className="grid flex-1 gap-4 sm:grid-cols-2">
                    <Controller
                      control={form.control}
                      name={`conditions.${index}.field`}
                      render={({ field }) => (
                        <Field>
                          <Select
                            value={field.value}
                            onValueChange={(value) => {
                              field.onChange(value);
                              // Value shapes differ per field (uuid, enum, amount).
                              form.setValue(`conditions.${index}.value`, "");
                            }}
                          >
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
                      id={`edit-rule-condition-value-${index}`}
                      field={conditionRows[index]?.field ?? "description_contains"}
                      accounts={accounts}
                      register={form.register(`conditions.${index}.value`)}
                      value={conditionRows[index]?.value ?? ""}
                      onChange={(value) =>
                        form.setValue(`conditions.${index}.value`, value)
                      }
                      error={
                        form.formState.errors.conditions?.[index]?.value?.message
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove condition ${index + 1}`}
                    // A rule needs at least one condition to match anything.
                    disabled={conditions.fields.length === 1}
                    onClick={() => conditions.remove(index)}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} />
                  </Button>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={conditions.fields.length >= MAX_CONDITIONS}
                onClick={() =>
                  conditions.append({ field: "description_contains", value: "" })
                }
              >
                <HugeiconsIcon icon={PlusSignIcon} />
                Add condition
              </Button>
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
                    <FieldLabel htmlFor="edit-rule-run-on-import">
                      Run on new imports
                    </FieldLabel>
                    <FieldDescription>
                      Also runs when CSV imports are committed.
                    </FieldDescription>
                  </span>
                  <Switch
                    id="edit-rule-run-on-import"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </Field>
              )}
            />

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

function ConditionValueField({
  id,
  field,
  accounts,
  value,
  onChange,
  register,
  error,
}: {
  id: string;
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
      <Input
        id={id}
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
      <FieldLabel htmlFor="edit-rule-action-value">Value</FieldLabel>
      <Input
        id="edit-rule-action-value"
        placeholder="e.g. Swiggy"
        {...register}
      />
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}
