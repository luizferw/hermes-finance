"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { simulatePurchaseParamsSchema } from "@/modules/finance/validators";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAYMENT_METHODS = [
  { value: "pix", label: "Pix" },
  { value: "boleto", label: "Boleto" },
  { value: "cash", label: "Cash" },
  { value: "credit_card", label: "Credit card" },
  { value: "debit_card", label: "Debit card" },
] as const;

/** An empty date/number input is "no value", not zero or an unparseable string. */
const emptyToNull = (value: unknown) => (value === "" ? null : value);

/**
 * Pushes the simulation request into the URL rather than calling a server
 * action — the result is a plain read, so it belongs on the query string and
 * stays linkable and re-runnable.
 */
export function SimulateForm({
  currencyCode,
  cards,
  initial,
}: {
  currencyCode: string;
  cards: Array<{ id: string; name: string }>;
  initial?: {
    method?: string;
    amount?: string;
    purchaseDate?: string;
    cardId?: string;
    installments?: string;
    neededBy?: string;
  };
}) {
  const router = useRouter();
  const form = useForm({
    resolver: zodResolver(simulatePurchaseParamsSchema),
    defaultValues: {
      method: (initial?.method ?? "pix") as "pix" | "boleto" | "cash" | "credit_card" | "debit_card",
      amount: initial?.amount ? Number(initial.amount) : (undefined as unknown as number),
      purchaseDate: initial?.purchaseDate ?? null,
      cardId: initial?.cardId ?? null,
      installments: initial?.installments ? Number(initial.installments) : null,
      neededBy: initial?.neededBy ?? null,
    },
  });
  const errors = form.formState.errors;
  const method = form.watch("method");

  const onSubmit = form.handleSubmit((values) => {
    const params = new URLSearchParams();
    params.set("method", values.method);
    params.set("amount", String(values.amount));
    if (values.purchaseDate) params.set("purchaseDate", values.purchaseDate);
    if (values.cardId) params.set("cardId", values.cardId);
    if (values.installments) params.set("installments", String(values.installments));
    if (values.neededBy) params.set("neededBy", values.neededBy);
    router.push(`/plan/simulate?${params.toString()}`);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="glass-panel rounded-2xl p-5">
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="method"
            render={({ field }) => (
              <Field>
                <FieldLabel>Payment method</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          />
          {method === "credit_card" && (
            <Field data-invalid={!!errors.cardId}>
              <FieldLabel>Card</FieldLabel>
              <Controller
                control={form.control}
                name="cardId"
                render={({ field }) => (
                  <Select value={field.value ?? undefined} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select the card" />
                    </SelectTrigger>
                    <SelectContent>
                      {cards.map((card) => (
                        <SelectItem key={card.id} value={card.id}>
                          {card.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.cardId && <FieldError>{errors.cardId.message}</FieldError>}
            </Field>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={!!errors.amount}>
            <FieldLabel htmlFor="simulate-amount">Amount ({currencyCode})</FieldLabel>
            <Input
              id="simulate-amount"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              placeholder="0.00"
              {...form.register("amount")}
            />
            {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
          </Field>
          <Field data-invalid={!!errors.purchaseDate}>
            <FieldLabel htmlFor="simulate-purchase-date">Purchase date</FieldLabel>
            <Input
              id="simulate-purchase-date"
              type="date"
              placeholder="Today"
              {...form.register("purchaseDate", { setValueAs: emptyToNull })}
            />
            {errors.purchaseDate && <FieldError>{errors.purchaseDate.message}</FieldError>}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={!!errors.installments}>
            <FieldLabel htmlFor="simulate-installments">Installments</FieldLabel>
            <Input
              id="simulate-installments"
              type="number"
              step="1"
              min="1"
              inputMode="numeric"
              placeholder="Single payment"
              {...form.register("installments", { setValueAs: emptyToNull })}
            />
            {errors.installments && <FieldError>{errors.installments.message}</FieldError>}
          </Field>
          <Field data-invalid={!!errors.neededBy}>
            <FieldLabel htmlFor="simulate-needed-by">Needed by (optional)</FieldLabel>
            <Input
              id="simulate-needed-by"
              type="date"
              placeholder="No deadline"
              {...form.register("neededBy", { setValueAs: emptyToNull })}
            />
            {errors.neededBy && <FieldError>{errors.neededBy.message}</FieldError>}
          </Field>
        </div>

        <Button type="submit">Simulate</Button>
      </FieldGroup>
    </form>
  );
}
