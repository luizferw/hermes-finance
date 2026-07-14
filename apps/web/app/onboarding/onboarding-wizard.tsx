"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { formatMoney, majorToMinor } from "@kosh/domain";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  REGIONS,
  CATEGORY_TIERS,
  regionByKey,
  type CategoryTier,
} from "@/modules/onboarding/data";
import { completeOnboarding } from "@/modules/onboarding/mutations";

const STEPS = ["Region", "Accounts", "Categories", "Review"] as const;

const ACCOUNT_TYPES = [
  { value: "asset", label: "Bank account" },
  { value: "cash", label: "Cash" },
  { value: "wallet", label: "Wallet (UPI)" },
  { value: "credit_card", label: "Credit card" },
  { value: "liability", label: "Loan / liability" },
  { value: "investment", label: "Investment" },
] as const;

interface AccountDraft {
  name: string;
  type: (typeof ACCOUNT_TYPES)[number]["value"];
  openingBalance: string;
}

const EXAMPLE_ACCOUNTS = "e.g. HDFC Salary, Cash, PhonePe wallet, HDFC Millennia";

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [regionKey, setRegionKey] = useState("IN");
  const [tier, setTier] = useState<CategoryTier>("recommended");
  const [accounts, setAccounts] = useState<AccountDraft[]>([
    { name: "", type: "asset", openingBalance: "" },
  ]);
  const [pending, startTransition] = useTransition();

  const region = regionByKey(regionKey)!;

  const netWorthMinor = useMemo(
    () =>
      accounts.reduce((sum, a) => {
        const major = Number.parseFloat(a.openingBalance);
        return sum + (Number.isFinite(major) ? majorToMinor(major, region.currencyCode) : 0);
      }, 0),
    [accounts, region.currencyCode],
  );

  function updateAccount(i: number, patch: Partial<AccountDraft>) {
    setAccounts((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function addAccount() {
    setAccounts((prev) => [...prev, { name: "", type: "asset", openingBalance: "" }]);
  }
  function removeAccount(i: number) {
    setAccounts((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit() {
    const cleaned = accounts
      .filter((a) => a.name.trim() !== "")
      .map((a) => ({
        name: a.name.trim(),
        type: a.type,
        openingBalance: Number.parseFloat(a.openingBalance) || 0,
      }));
    startTransition(async () => {
      try {
        // Redirects to /overview on success (throws NEXT_REDIRECT, handled by Next).
        await completeOnboarding({ regionKey, categoryTier: tier, accounts: cleaned });
      } catch (error) {
        const digest = (error as { digest?: string })?.digest;
        if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return;
        toast.error("Could not finish setup. Please try again.");
      }
    });
  }

  return (
    <div className="space-y-6">
      <Stepper step={step} />

      {step === 0 && (
        <Section
          title="Where do you bank?"
          hint="Sets your currency, number format, and financial year. Change it later in Settings."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {REGIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRegionKey(r.key)}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition ${
                  regionKey === r.key
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-ledger hover:border-foreground/30"
                }`}
              >
                <span className="text-2xl">{r.flag}</span>
                <span className="text-sm font-medium">{r.label}</span>
                <span className="text-xs text-muted-foreground">{r.currencyCode}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {step === 1 && (
        <Section title="Add your accounts" hint={EXAMPLE_ACCOUNTS}>
          <div className="space-y-3">
            {accounts.map((a, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
                <Input
                  placeholder="Account name"
                  value={a.name}
                  onChange={(e) => updateAccount(i, { name: e.target.value })}
                  className="col-span-2 sm:col-span-1"
                />
                <select
                  value={a.type}
                  onChange={(e) =>
                    updateAccount(i, { type: e.target.value as AccountDraft["type"] })
                  }
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs"
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <Input
                  inputMode="decimal"
                  placeholder="Balance"
                  value={a.openingBalance}
                  onChange={(e) => updateAccount(i, { openingBalance: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove account"
                  onClick={() => removeAccount(i)}
                  disabled={accounts.length === 1}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addAccount}>
              + Add another account
            </Button>
          </div>
          <NetWorthPreview minor={netWorthMinor} currency={region.currencyCode} />
        </Section>
      )}

      {step === 2 && (
        <Section
          title="Pick your spending categories"
          hint="Start small — you can always add more. We never dump 80 on you."
        >
          <div className="space-y-3">
            {(Object.keys(CATEGORY_TIERS) as CategoryTier[]).map((key) => {
              const cats = CATEGORY_TIERS[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTier(key)}
                  className={`w-full rounded-lg border p-3 text-left transition ${
                    tier === key
                      ? "border-primary ring-2 ring-primary/30"
                      : "border-ledger hover:border-foreground/30"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium capitalize">{key}</span>
                    <span className="text-xs text-muted-foreground">
                      {cats.length} categories
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {cats.slice(0, 8).map((c) => (
                      <span
                        key={c.name}
                        className="rounded-full border border-ledger px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {c.name}
                      </span>
                    ))}
                    {cats.length > 8 && (
                      <span className="px-1 text-xs text-muted-foreground">
                        +{cats.length - 8} more
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {step === 3 && (
        <Section title="You're all set" hint="Review and finish — this takes a second.">
          <Card className="gap-0 divide-y divide-ledger p-0">
            <ReviewRow label="Region" value={`${region.flag} ${region.label} · ${region.currencyCode}`} />
            <ReviewRow
              label="Accounts"
              value={`${accounts.filter((a) => a.name.trim()).length} added`}
            />
            <ReviewRow
              label="Starting net worth"
              value={formatMoney(netWorthMinor, region.currencyCode)}
            />
            <ReviewRow label="Categories" value={`${CATEGORY_TIERS[tier].length} (${tier})`} />
          </Card>
          <p className="text-xs text-muted-foreground">
            You can import transactions from a CSV anytime under Transactions → Import.
          </p>
        </Section>
      )}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0 || pending}
        >
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={submit} disabled={pending}>
            Skip for now
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={pending}>
              Continue
            </Button>
          ) : (
            <Button type="button" onClick={submit} disabled={pending}>
              {pending ? "Setting up…" : "Finish"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex flex-1 flex-col gap-1">
          <div className={`h-1 rounded-full ${i <= step ? "bg-primary" : "bg-muted"}`} />
          <span
            className={`text-xs ${i === step ? "text-foreground" : "text-muted-foreground"}`}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="font-serif text-2xl">{title}</h1>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function NetWorthPreview({ minor, currency }: { minor: number; currency: string }) {
  return (
    <div className="mt-4 flex items-center justify-between rounded-lg border border-ledger bg-muted/30 px-4 py-3">
      <Label className="micro-label">Starting net worth</Label>
      <span className="font-amount text-lg font-medium">{formatMoney(minor, currency)}</span>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}
