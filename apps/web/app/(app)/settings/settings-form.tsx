"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateUserSettings } from "@/modules/settings/mutations";
import type { UserSettingsData } from "@/modules/settings/queries";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD"] as const;
const LOCALES = [
  { value: "en-IN", label: "English (India)" },
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
] as const;
const DATE_FORMATS = ["dd MMM yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy"] as const;

export function SettingsForm({ settings }: { settings: UserSettingsData }) {
  const router = useRouter();
  const [currencyCode, setCurrencyCode] = React.useState(settings.currencyCode);
  const [locale, setLocale] = React.useState(settings.locale);
  const [dateFormat, setDateFormat] = React.useState(settings.dateFormat);
  const [isPending, startTransition] = React.useTransition();

  function save() {
    startTransition(async () => {
      try {
        await updateUserSettings({ currencyCode, locale, dateFormat });
        toast.success("Settings saved");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save settings");
      }
    });
  }

  return (
    <FieldGroup className="max-w-xl">
      <Field>
        <FieldLabel>Display currency</FieldLabel>
        <Select value={currencyCode} onValueChange={setCurrencyCode}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((currency) => (
              <SelectItem key={currency} value={currency}>
                {currency}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Used for dashboard and report totals; transactions keep their stored
          currency code.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Locale</FieldLabel>
        <Select value={locale} onValueChange={setLocale}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel>Date format</FieldLabel>
        <Select value={dateFormat} onValueChange={setDateFormat}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                {format}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Button className="w-fit" disabled={isPending} onClick={save}>
        {isPending && <Spinner />}
        Save settings
      </Button>
    </FieldGroup>
  );
}
